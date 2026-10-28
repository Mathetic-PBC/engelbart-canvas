import Foundation

// The pane beside the document (model/panes.js, MATH-23), in the manner of Andy Matuschak's working notes: a note's or a
// workspace's mention clicked opens its document in a pane to the right of the document in front. Pure: the Workspace
// keeps the list and draws it.
//
// Two panes at most (2026-10-05): pane 0 is the document in front (the tab), which this list never holds, and pane 1 is
// the list's one entry. A mention clicked in either pane puts its document in pane 1, in place of what was there; one
// already in front is not opened a second time (two editors on one document undid each other's typing with ⌘Z).

public struct DocRef: Equatable, Sendable {
    public enum Kind: String, Sendable { case note, workspace }
    public var kind: Kind
    public var id: String
    public var title: String
    public init(kind: Kind = .note, id: String, title: String = "") { self.kind = kind; self.id = id; self.title = title }
}

/// A pane: the document's kind, id and name, and `link`, the mention's text clicked to open it, which stays marked in
/// the document in front.
public struct Pane: Equatable, Sendable {
    public var kind: DocRef.Kind
    public var id: String
    public var title: String
    public var link: String
    public init(kind: DocRef.Kind, id: String, title: String, link: String) { self.kind = kind; self.id = id; self.title = title; self.link = link }
}

public enum Panes {
    /// Whether two documents are the same: same id and kind (no kind is a note). Nil or an empty id never matches.
    public static func sameDoc(_ a: (kind: DocRef.Kind, id: String)?, _ b: (kind: DocRef.Kind, id: String)?) -> Bool {
        guard let a, let b, !a.id.isEmpty else { return false }
        return a.id == b.id && a.kind == b.kind
    }

    /// `item` opened from a mention (`link`) clicked in either pane; `front` is what the document in front shows (nil for
    /// neither, an archived version). → the list after it (`panes` itself when nothing changed) and the pane that shows
    /// the item: 0 when it is the document in front, 1 beside, nil when there is nothing to open.
    public static func openBeside(_ panes: [Pane], front: (kind: DocRef.Kind, id: String)?, item: DocRef?, link: String?) -> (panes: [Pane], at: Int?) {
        guard let item, !item.id.isEmpty else { return (panes, nil) }
        if sameDoc(front, (item.kind, item.id)) { return (panes, 0) }
        let shown = link ?? ""
        if let now = panes.first, sameDoc((now.kind, now.id), (item.kind, item.id)) {
            var kept = now; kept.link = shown
            return (now.link == shown ? panes : [kept], 1)
        }
        return ([Pane(kind: item.kind, id: item.id, title: item.title, link: shown)], 1)
    }

    /// Pane `index` closed (its ×), and every pane after it. The document (pane 0) does not close.
    public static func closePane(_ panes: [Pane], _ index: Int) -> [Pane] {
        guard index >= 1, index <= panes.count else { return panes }
        return Array(panes.prefix(index - 1))
    }
}
