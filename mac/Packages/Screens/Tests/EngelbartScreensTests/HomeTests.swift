import EngelbartCore
import EngelbartDoc
import EngelbartStore
import XCTest
@testable import EngelbartScreens

// Home.jsx's logic (HomeLogic) and its state (HomeModel), driven with a fake api.

final class HomeLogicTests: XCTestCase {
    func testRowsSortedByKindThenNewestWithoutPastedPictures() {
        let library = [
            row("a", "Site", type: "website", lastEdited: "2026-10-05T00:00:00.000Z"),
            row("b", "Paper old", type: "pdf", lastEdited: "2026-10-01T00:00:00.000Z"),
            row("c", "Note", type: "md", tags: ["note"], projectId: "p", lastEdited: "2026-09-01T00:00:00.000Z"),
            row("d", "Paper new", type: "pdf", lastEdited: "2026-10-03T00:00:00.000Z"),
            row("e", "Pasted", type: "image", projectId: "p"),
            row("f", "Added picture", type: "image"),
            row("g", "Repo", type: "website", tags: ["git"]),
            row("h", "Weird", type: "xyz"),
        ]
        XCTAssertEqual(HomeLogic.rows(library).map(\.id), ["c", "d", "b", "g", "a", "f", "h"])
        let ids = HomeLogic.rows(library).map(\.id)
        XCTAssertFalse(ids.contains("e"), "a picture pasted into a document is its project's attachment")
        XCTAssertTrue(ids.contains("f"), "one added to the library is listed (MATH-19)")
        XCTAssertEqual(Array(ids.prefix(5)), ["c", "d", "b", "g", "a"], "note, pdf (newest first), git, website")
        XCTAssertEqual(ids.last, "h", "an unknown kind last")
    }

    func testSearchByNameAddressKindSummaryAndWhatItSays() {
        let rows = [row("a", "Teachable agents", type: "pdf", tags: ["paper"]), row("b", "Site", type: "website", url: "https://memex.org"),
                    row("c", "Thing", type: "pdf", summary: "About Vannevar Bush"), row("d", "Quiet", type: "pdf")]
        XCTAssertEqual(HomeLogic.matches(rows, query: "  ", bodies: nil).count, 4)
        XCTAssertEqual(HomeLogic.matches(rows, query: "TEACH", bodies: nil).map(\.id), ["a"])
        XCTAssertEqual(HomeLogic.matches(rows, query: "memex", bodies: nil).map(\.id), ["b"])
        XCTAssertEqual(HomeLogic.matches(rows, query: "paper", bodies: nil).map(\.id), ["a"], "the kind label: pdf · paper")
        XCTAssertEqual(HomeLogic.matches(rows, query: "link", bodies: nil).map(\.id), ["b"], "a website's kind is link")
        XCTAssertEqual(HomeLogic.matches(rows, query: "vannevar", bodies: nil).map(\.id), ["c"])
        XCTAssertEqual(HomeLogic.matches(rows, query: "hypertext", bodies: ["d": "as we may think: hypertext"]).map(\.id), ["d"], "what the pdf says")
    }

    func testRelativeAndDay() {
        let now = ISO8601DateFormatter().date(from: "2026-10-10T12:00:00Z")!
        func ago(_ seconds: Double) -> String {
            let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return f.string(from: now.addingTimeInterval(-seconds))
        }
        XCTAssertEqual(HomeLogic.relative(nil, now: now), "")
        XCTAssertEqual(HomeLogic.relative(ago(20), now: now), "just now")
        XCTAssertEqual(HomeLogic.relative(ago(5 * 60), now: now), "5 min ago")
        XCTAssertEqual(HomeLogic.relative(ago(90 * 60), now: now), "2 h ago", "hours rounded")
        XCTAssertEqual(HomeLogic.relative(ago(30 * 3600), now: now), "yesterday")
        XCTAssertEqual(HomeLogic.relative(ago(2 * 86400), now: now), "2 days ago")
        XCTAssertEqual(HomeLogic.relative("2026-10-10T11:00:00Z", now: now), "1 h ago", "a date without milliseconds")
        XCTAssertEqual(HomeLogic.day("2026-10-10T12:00:00.000Z", locale: Locale(identifier: "en_US")), "Oct 10")
        XCTAssertEqual(HomeLogic.cardMeta(workspaceCount: 1, lastEdited: nil), "1 project")
        XCTAssertEqual(HomeLogic.cardMeta(workspaceCount: 3, lastEdited: ago(60 * 5), now: now), "3 projects · edited 5 min ago")
    }

    func testHeldKindsOnceEachAtMostFive() {
        XCTAssertNil(HomeLogic.heldIcons([]))
        let two = HomeLogic.heldIcons([row("a", "x", type: "pdf"), row("b", "y", type: "pdf"), row("c", "z", type: "md", tags: ["note"])])!
        XCTAssertEqual(two.kinds, ["note", "pdf"]); XCTAssertEqual(two.caption, "+ 1 more")
        let each = HomeLogic.heldIcons([row("a", "x", type: "pdf"), row("c", "z", type: "website")])!
        XCTAssertEqual(each.caption, "2 from the library", "the glyphs stand for every item")
        let many = HomeLogic.heldIcons(["note", "md", "docx", "pdf", "folder", "website", "html"].enumerated().map { row("\($0.offset)", "x", type: $0.element == "note" ? "md" : $0.element, tags: $0.element == "note" ? ["note"] : []) })!
        XCTAssertEqual(many.kinds, ["note", "md", "docx", "pdf", "folder"], "at most five, in the rail's order")
        XCTAssertEqual(many.caption, "+ 2 more")
    }

    func testTilesAndPeekPlacement() {
        XCTAssertEqual(HomeLogic.tiles(columnWidth: 999), 2); XCTAssertEqual(HomeLogic.tiles(columnWidth: 1000), 3)
        XCTAssertEqual(HomeLogic.tiles(columnWidth: 1499), 3); XCTAssertEqual(HomeLogic.tiles(columnWidth: 1500), 4)
        let window = CGSize(width: 1440, height: 900)
        let rail = HomeLogic.peekFrame(row: CGRect(x: 0, y: 200, width: 340, height: 31.5), workspace: false, window: window)
        XCTAssertEqual(rail, .init(left: 340, top: 188, width: 380, maxHeight: 440, onRight: true))
        let low = HomeLogic.peekFrame(row: CGRect(x: 0, y: 860, width: 340, height: 31.5), workspace: false, window: window)
        XCTAssertEqual(low.top, 520, "never below the window's height − 380"); XCTAssertEqual(low.maxHeight, 368)
        let high = HomeLogic.peekFrame(row: CGRect(x: 0, y: 20, width: 340, height: 31.5), workspace: false, window: window)
        XCTAssertEqual(high.top, 54, "never over the header")
        let tile = HomeLogic.peekFrame(row: CGRect(x: 1200, y: 300, width: 168, height: 200), workspace: true, window: window)
        XCTAssertEqual(tile.width, 420); XCTAssertEqual(tile.left, 1200 - 420 - 8, "no room on the right: on the left"); XCTAssertFalse(tile.onRight)
        XCTAssertEqual(tile.maxHeight, 520)
    }

    func testWorkspaceTrailSourceAndShownLibrary() {
        XCTAssertEqual(HomeLogic.workspaceTrail(project: "Thesis", path: "Plan", name: "Plan"), "Thesis")
        XCTAssertEqual(HomeLogic.workspaceTrail(project: "Thesis", path: "Agents/Inline/Plan", name: "Plan"), "Thesis / Agents / Inline")
        XCTAssertEqual(HomeLogic.source(row("a", "x", type: "website", url: "https://www.memex.org/as-we-may-think/")), "memex.org/as-we-may-think")
        XCTAssertEqual(HomeLogic.source(row("a", "x", path: "/Users/h/papers/bush.pdf")), "bush.pdf")
        XCTAssertEqual(HomeLogic.source(row("a", "x")), "")
        let now = Date()
        let gone = trashed("p2", "Old", deleted: now, expires: now)
        XCTAssertEqual(HomeLogic.shownLibrary([row("a", "x", projectId: "p2"), row("b", "y", projectId: "p1"), row("c", "z")], trashed: [gone]).map(\.id), ["b", "c"])
        XCTAssertEqual(HomeLogic.kindLabel(row("a", "x", type: "pdf", tags: ["paper"])), "pdf · paper")
        XCTAssertEqual(HomeLogic.kindLabel(row("a", "x", type: "website", tags: ["git"])), "link · git", "kindOf: a repository is not a fixed kind: its type then its tags")
    }
}

@MainActor
final class HomeModelTests: XCTestCase {
    var data = FakeData()
    var opened: [String] = []
    var renamed: [(String, String)] = []
    var deleted: [String] = []
    var restored: [String] = []
    var reloads = 0
    var created = 0

    func make() -> HomeModel {
        let context = HomeContext(
            data: data,
            onCreateScreen: { self.created += 1 },
            onOpenWorkspace: { p, w, stage in self.opened.append("ws \(p) \(w ?? "-") \(stage?.id ?? "-")") },
            onOpenNote: { self.opened.append("note \($0.id)") },
            onOpenOnStage: { self.opened.append("stage \($0.id)") },
            onRename: { self.renamed.append(($0, $1)) },
            onDelete: { id in self.deleted.append(id) },
            onRestore: { id in try? await Task.sleep(nanoseconds: 50_000_000); self.restored.append(id) },
            onLibraryChanged: { self.reloads += 1 })
        let model = HomeModel(context: context)
        model.delays = (0.05, 0.02, 0.05)
        model.flashTime = 0.2
        return model
    }

    func testOpeningARow() async {
        let model = make()
        await model.openRow(row("n", "Note", type: "md", tags: ["note"], projectId: "p1"))
        data.holders["a"] = [holder("p1", "No workspaces"), holder("p2", "Held", workspaces: [("w2", "Plan"), ("w3", "Other")])]
        await model.openRow(row("a", "Paper"))
        data.holders["b"] = [holder("p3", "Origin only")]
        await model.openRow(row("b", "Origin"))
        await model.openRow(row("c", "Nobody"))
        data.holdersFail = true
        await model.openRow(row("d", "Gone"))
        XCTAssertEqual(opened, ["note n", "ws p2 w2 a", "ws p3 - b", "stage c", "stage d"])
        model.openCard(project("p9", "Card"))
        XCTAssertEqual(opened.last, "ws p9 - -", "a card opens where the project was left")
    }

    func testAddingEachInOrderFlashingTheLast() async throws {
        let model = make()
        model.query = "x"
        data.refuse["bad"] = "Nothing is at bad"
        let problems = await model.addEach(["https://a.org", "bad", "https://b.org"])
        XCTAssertEqual(problems, ["Nothing is at bad"])
        XCTAssertEqual(data.calls.filter { $0.hasPrefix("add") }, ["add https://a.org", "add bad", "add https://b.org"])
        XCTAssertEqual(model.query, "", "the search is cleared to show it")
        XCTAssertEqual(model.justAdded, data.rows.last?.id, "the last one added flashes")
        XCTAssertEqual(reloads, 1)
        await until { model.justAdded == nil }
        XCTAssertNil(model.justAdded, "the flash ends")
        // Add context's onAdd throws what could not be added, joined.
        do { try await model.addHandlers.onAdd("bad"); XCTFail("refused") } catch { XCTAssertEqual(errorMessage(error), "Nothing is at bad") }
        // Choose from disk: each picked path its own row.
        data.picked = ["/Users/h/a.pdf", "/Users/h/b.pdf"]
        await model.addHandlers.onPickDisk()
        XCTAssertEqual(data.calls.suffix(3), ["pick ", "add /Users/h/a.pdf", "add /Users/h/b.pdf"])
        // A repository the library holds opens; else its address is added. A search result likewise.
        try await model.addHandlers.onPickRepo("https://github.com/a/b", row("r", "a/b", type: "website", tags: ["git"]))
        XCTAssertEqual(opened.last, "stage r")
        try await model.addHandlers.onSearchPick(.fresh("https://c.org"))
        XCTAssertEqual(data.calls.last, "add https://c.org")
        XCTAssertFalse(model.addHandlers.inRail("anything"), "Home has no rail of its own")
    }

    func testDropsAddEachInOrderAndSayWhatFailed() async {
        let model = make()
        data.refuse["https://nope.org"] = "Could not read that page"
        await model.dropAll([.path("/Users/h/x.pdf"), .bytes(Data([1, 2, 3]), mime: "image/png", name: nil), .url("https://nope.org"), .url("https://ok.org")])
        XCTAssertEqual(data.calls, ["add /Users/h/x.pdf", "file image/png 3", "url https://nope.org", "url https://ok.org"])
        XCTAssertEqual(model.addError, "Could not read that page")
        XCTAssertFalse(model.addBusy)
        XCTAssertEqual(model.justAdded, data.rows.last?.id)
        await model.dropAll([])
        XCTAssertEqual(model.addError, "", "a new drop clears what the last one said")
        XCTAssertEqual(Drop.readDrop(files: [], uriList: "# comment\nhttps://www.google.com/imgres?imgurl=https://x.org/p.png", html: nil), [.url("https://x.org/p.png")])
    }

    func testPeekOpensAfterABeatSwitchesFasterAndClosesAfterLeaving() async {
        let model = make()
        let a = HomePeek(key: "a", kind: .item(row("a", "A")), rect: CGRect(x: 0, y: 100, width: 340, height: 31.5))
        let b = HomePeek(key: "b", kind: .item(row("b", "B")), rect: CGRect(x: 0, y: 132, width: 340, height: 31.5))
        model.openPeek(a)
        XCTAssertNil(model.peek, "not at once")
        await until { model.peek != nil }
        XCTAssertEqual(model.peek?.key, "a")
        model.closePeek()
        model.openPeek(b) // onto the next row: the close is cancelled, the switch is quicker
        await until { model.peek?.key == "b" }
        XCTAssertEqual(model.peek?.key, "b")
        model.closePeek()
        model.hold() // onto the peek itself
        await settle(0.12)
        XCTAssertEqual(model.peek?.key, "b", "the pointer on the peek keeps it")
        model.closePeek()
        await until { model.peek == nil }
        XCTAssertNil(model.peek)
        model.openPeek(a); await until { model.peek != nil }
        model.dropPeek()
        XCTAssertNil(model.peek, "a scroll or a press closes it at once")
    }

    func testPreviewsAskedOncePerVersion() async {
        let model = make()
        let a = row("a", "Notes.md", type: "md")
        data.previews["a"] = preview("a", text: "# Hello")
        model.loadPreview(for: a); model.loadPreview(for: a)
        await until { model.preview(for: a) != nil }
        XCTAssertEqual(model.preview(for: a)?.text, "# Hello")
        XCTAssertEqual(data.calls.filter { $0 == "preview a" }.count, 1)
        var edited = a; edited.lastEdited = "2026-10-20T00:00:00.000Z"
        model.loadPreview(for: edited)
        await until { data.calls.filter { $0 == "preview a" }.count == 2 }
        XCTAssertEqual(data.calls.filter { $0 == "preview a" }.count, 2, "asked again once the row changed")
        let b = row("b", "x")
        model.loadPreview(for: b)
        await settle()
        XCTAssertNil(model.preview(for: b), "a failure counts as nothing more")
        model.loadPreview(for: b)
        XCTAssertEqual(data.calls.filter { $0 == "preview b" }.count, 1, "and is not asked again")
    }

    func testBodiesOnlyWhileSearching() async {
        let model = make()
        data.bodies = ["a": "Hypertext AND Memex"]
        model.library = [row("a", "Paper")]
        XCTAssertNil(model.bodies)
        model.query = "memex"
        await until { model.bodies != nil }
        XCTAssertEqual(model.bodies?["a"], "hypertext and memex", "lower-cased")
        XCTAssertEqual(model.shown.map(\.id), ["a"])
        model.query = "memexes"
        XCTAssertEqual(data.calls.filter { $0 == "bodies" }.count, 1, "asked when typing starts, not on each key")
        XCTAssertTrue(model.escapeSearch()); XCTAssertEqual(model.query, "")
        XCTAssertNil(model.bodies, "let go when cleared")
        XCTAssertFalse(model.escapeSearch(), "empty: Escape passes on")
    }

    func testRenameDeleteRestore() async {
        let model = make()
        let thesis = project("p1", "Thesis")
        model.startRename("p1")
        model.commitRename(thesis, "Thesis")
        XCTAssertNil(model.renaming); XCTAssertTrue(renamed.isEmpty, "unchanged: nothing")
        model.startRename("p1"); model.commitRename(thesis, "Dissertation")
        XCTAssertEqual(renamed.first?.1, "Dissertation")
        model.startRename("p1"); model.cancelRename(); XCTAssertNil(model.renaming)

        model.askDelete(thesis)
        XCTAssertEqual(model.deleting?.id, "p1")
        model.cancelDelete(); XCTAssertNil(model.deleting)
        model.askDelete(thesis)
        await model.confirmDelete()
        XCTAssertEqual(deleted, ["p1"]); XCTAssertNil(model.deleting); XCTAssertFalse(model.deleteBusy)

        model.restoring = "p2" // one restoring: no second one anywhere
        await model.restore("p3")
        XCTAssertTrue(restored.isEmpty)
        model.restoring = nil
        await model.restore("p2")
        XCTAssertEqual(restored, ["p2"]); XCTAssertNil(model.restoring, "done: Restore again")
    }

    func testHeldRowsAndUpdate() {
        let model = make()
        model.update(projects: [project("p1", "T", libraryIds: ["b", "zz", "a"])], trashed: [], library: [row("a", "A"), row("b", "B")], error: "")
        XCTAssertEqual(model.held(model.projects[0]).map(\.id), ["b", "a"], "ids the library no longer has are left out")
        XCTAssertEqual(model.rows.count, 2)
        // The app's JSON lists (RootModel), summaries without slug or dir.
        model.update(projectsJSON: [["id": "p9", "name": "From JSON", "workspaceCount": 2, "lastEdited": nil, "libraryIds": ["a"]]],
                     trashedJSON: [["id": "p8", "name": "Gone", "deleted": "2026-10-01T00:00:00.000Z", "expires": "2026-10-08T00:00:00.000Z", "workspaceCount": 1]],
                     libraryJSON: [["id": "a", "name": "A", "type": "pdf", "tags": ["paper"], "project_id": nil, "last_edited": "2026-10-02T00:00:00.000Z"]], error: "x")
        XCTAssertEqual(model.projects.map(\.name), ["From JSON"]); XCTAssertEqual(model.projects.first?.workspaceCount, 2)
        XCTAssertEqual(model.trashed.map(\.id), ["p8"])
        XCTAssertEqual(model.library.first?.tags, ["paper"]); XCTAssertEqual(model.error, "x")
    }
}
