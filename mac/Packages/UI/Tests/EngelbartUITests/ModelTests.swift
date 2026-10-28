import XCTest
@testable import EngelbartUI

// Ports of test/place.test.cjs, test/panes-model.test.cjs and test/welcome-place.test.cjs.

final class PlaceTests: XCTestCase {
    let view = CGSize(width: 1200, height: 800)
    func a(_ l: CGFloat, _ r: CGFloat, _ t: CGFloat, _ b: CGFloat) -> PlaceAnchor { PlaceAnchor(left: l, right: r, top: t, bottom: b) }

    func testPlaceBelowAboveOrLargerSide() {
        XCTAssertEqual(Placement.place(a(100, 180, 100, 120), size: CGSize(width: 300, height: 250), view: view), PlaceSpot(left: 100, top: 126, maxHeight: nil))
        XCTAssertEqual(Placement.place(a(100, 180, 700, 720), size: CGSize(width: 300, height: 250), view: view), PlaceSpot(left: 100, top: 444, maxHeight: nil),
                       "no room under the line: it opens above it")
        XCTAssertEqual(Placement.place(a(100, 180, 380, 400), size: CGSize(width: 300, height: 700), view: view), PlaceSpot(left: 100, top: 406, maxHeight: 386),
                       "too tall for either side: the side with more room, cut to it")
        XCTAssertEqual(Placement.place(a(100, 180, 500, 520), size: CGSize(width: 300, height: 700), view: view), PlaceSpot(left: 100, top: 8, maxHeight: 486))
        XCTAssertEqual(Placement.place(a(1100, 1180, 100, 120), size: CGSize(width: 330, height: 100), view: view).left, 862, "it stays inside the window sideways")
        XCTAssertEqual(Placement.place(a(900, 1000, 100, 120), size: CGSize(width: 332, height: 100), view: view, align: .end).left, 668,
                       "a right-aligned panel hangs from the right edge")
    }

    func testPlaceBeside() {
        let row = a(8, 300, 200, 228)
        XCTAssertEqual(Placement.beside(row, size: CGSize(width: 340, height: 300), view: view), PlaceSpot(left: 308, top: 200, maxHeight: nil))
        XCTAssertEqual(Placement.beside(a(8, 300, 700, 728), size: CGSize(width: 340, height: 300), view: view), PlaceSpot(left: 308, top: 492, maxHeight: nil),
                       "near the bottom it moves up")
        XCTAssertEqual(Placement.beside(row, size: CGSize(width: 340, height: 900), view: view), PlaceSpot(left: 308, top: 8, maxHeight: 784),
                       "taller than the window: cut to it, and it scrolls")
        XCTAssertEqual(Placement.beside(a(900, 1000, 100, 120), size: CGSize(width: 340, height: 100), view: view).left, 552, "no room on the right: on the left")
        XCTAssertEqual(Placement.place(row, size: CGSize(width: 340, height: 300), view: view, side: .right),
                       Placement.beside(row, size: CGSize(width: 340, height: 300), view: view, gap: 6), "place() with side right is placeBeside")
    }
}

final class PanesTests: XCTestCase {
    let front: (kind: DocRef.Kind, id: String)? = (.workspace, "w1")
    func note(_ id: String) -> DocRef { DocRef(kind: .note, id: id, title: id.uppercased()) }
    func space(_ id: String) -> DocRef { DocRef(kind: .workspace, id: id, title: id.uppercased()) }
    func pane(_ id: String, _ link: String? = nil, _ kind: DocRef.Kind = .note) -> Pane { Pane(kind: kind, id: id, title: id.uppercased(), link: link ?? id) }

    func testNoteOpensBesideAndReplaces() {
        let one = Panes.openBeside([], front: front, item: note("a"), link: "A")
        XCTAssertEqual(one.panes, [Pane(kind: .note, id: "a", title: "A", link: "A")]); XCTAssertEqual(one.at, 1)
        XCTAssertEqual(Panes.openBeside(one.panes, front: front, item: note("b"), link: "B").panes.map(\.id), ["b"])
        XCTAssertEqual(Panes.openBeside([], front: front, item: DocRef(id: "a"), link: nil).panes, [Pane(kind: .note, id: "a", title: "", link: "")])
    }

    func testTwoPanesAtMost() {
        var panes: [Pane] = []
        for id in ["a", "b", "c", "d", "e"] {
            let out = Panes.openBeside(panes, front: front, item: note(id), link: id)
            XCTAssertEqual(out.at, 1); XCTAssertEqual(out.panes.count, 1)
            panes = out.panes
        }
        XCTAssertEqual(panes.map(\.id), ["e"])
        XCTAssertEqual(Panes.openBeside([pane("a"), pane("b"), pane("c")], front: front, item: note("x"), link: "x").panes.map(\.id), ["x"])
    }

    func testSameNoteTakesNewLink() {
        let held = [pane("a", "old")]
        let same = Panes.openBeside(held, front: front, item: note("a"), link: "new")
        XCTAssertEqual(same.panes, [Pane(kind: .note, id: "a", title: "A", link: "new")]); XCTAssertEqual(same.at, 1)
        let again = Panes.openBeside(held, front: front, item: note("a"), link: "old")
        XCTAssertEqual(again.panes, held); XCTAssertEqual(again.at, 1)
    }

    func testFrontIsNotOpenedAgain() {
        let held = [pane("b")]
        let out = Panes.openBeside(held, front: (.note, "a"), item: note("a"), link: "A")
        XCTAssertEqual(out.at, 0); XCTAssertEqual(out.panes, held)
        XCTAssertEqual(Panes.openBeside([], front: (.note, "a"), item: note("a"), link: "A").panes.count, 0)
        XCTAssertEqual(Panes.openBeside(held, front: front, item: space("w1"), link: "W1").at, 0)
        XCTAssertEqual(Panes.openBeside(held, front: nil, item: note("a"), link: "A").at, 1, "an archived version in front is neither")
        XCTAssertFalse(Panes.sameDoc((.note, "x"), (.workspace, "x")))
        XCTAssertFalse(Panes.sameDoc(nil, nil))
    }

    func testWorkspaceMentionAndNothingToOpen() {
        let out = Panes.openBeside([pane("a")], front: front, item: space("w2"), link: "Elsewhere")
        XCTAssertEqual(out.panes, [Pane(kind: .workspace, id: "w2", title: "W2", link: "Elsewhere")]); XCTAssertEqual(out.at, 1)
        XCTAssertEqual(Panes.openBeside(out.panes, front: front, item: note("w2"), link: "w2").panes.first?.kind, .note)
        XCTAssertEqual(Panes.openBeside(out.panes, front: front, item: space("w2"), link: "Elsewhere").panes, out.panes)
        let held = [pane("a")]
        XCTAssertNil(Panes.openBeside(held, front: front, item: nil, link: "x").at)
        XCTAssertNil(Panes.openBeside(held, front: front, item: DocRef(id: ""), link: "x").at)
    }

    func testClosePane() {
        let one = [pane("a")]
        XCTAssertEqual(Panes.closePane(one, 1), [])
        XCTAssertEqual(Panes.closePane(one, 0), one, "pane 0 is the document")
        XCTAssertEqual(Panes.closePane(one, 2), one)
        XCTAssertEqual(Panes.closePane([], 1), [])
    }
}

final class WelcomePlaceTests: XCTestCase {
    let tree = WelcomeTree(workspaces: [
        .init(id: "a", name: "Getting started"),
        .init(id: "b", name: "Welcome", children: [.init(id: "b1", name: "Reading")]),
        .init(id: "c", name: "Welcome 2"),
        .init(id: "d", name: "Welcome back notes"),
    ], notes: [.init(id: "n1", name: "Welcome!", workspaceId: "a")])

    func testGivenWins() {
        XCTAssertEqual(WelcomePlace.landing(tree, given: "b1", current: "a"), WelcomeLanding(workspaceId: "b1", tab: nil))
    }

    func testNewestWelcome() {
        XCTAssertEqual(WelcomePlace.landing(tree, current: "a"), WelcomeLanding(workspaceId: "c", tab: nil))
        XCTAssertEqual(WelcomePlace.landing(tree, given: "gone"), WelcomeLanding(workspaceId: "c", tab: nil))
    }

    func testNoWelcomeWorkspace() {
        let older = WelcomeTree(workspaces: [.init(id: "a", name: "Getting started"), .init(id: "z", name: "Other")], notes: tree.notes)
        XCTAssertEqual(WelcomePlace.landing(older, current: "a"), WelcomeLanding(workspaceId: "a", tab: .init(id: "n1", title: "Welcome!")))
        XCTAssertEqual(WelcomePlace.landing(older, current: "z"), WelcomeLanding(workspaceId: "z", tab: nil))
        XCTAssertEqual(WelcomePlace.landing(WelcomeTree(workspaces: [], notes: [])), WelcomeLanding(workspaceId: nil, tab: nil))
    }
}
