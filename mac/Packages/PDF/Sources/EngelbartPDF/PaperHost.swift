import AppKit
import Foundation
import EngelbartCore

// What the app gives a paper (the React props PaperView took from the Stage: src/renderer/workspace/Stage.jsx
// <PaperView …>). Every method has a default, so a host implements what it can: with no mention handler a note is always
// its field (PaperView showsNotes), with no ask handler a note never asks, and so on, as with the props left out.

/// A question asked from a highlight's note (PaperView askFrom → the Stage's askFromPaper, which adds where the pdf is
/// and its name, then ipc `ask-bart` with ref kind 'mark').
public struct PaperAsk: Equatable, Sendable {
    public var markId: String
    public var page: Int
    /// The passage: the mark's text, or every part of its selection across pages (marks.js passageOf).
    public var quote: String
    /// The note as it stands.
    public var note: String
    /// What follows @bart.
    public var question: String
    /// The mark's earlier answers as turns (deleted ones too while their session lasts).
    public var turns: [Canvas.Turn]
    /// The page's text around the passage (marks.js pageWindow), '' when it could not be had within 2 s.
    public var pageText: String
}

/// What Continue in project sends (PaperView askClick 'continue'); the host adds the paper (Stage onContinueAsk).
public struct PaperContinue: Equatable, Sendable {
    public var markId: String
    public var page: Int
    public var quote: String
    public var question: String
    public var answer: String
    public var foot: String
}

/// Where the paper was read to (MATH-16): restored when its tab comes back.
public struct PaperViewState: Equatable, Sendable {
    public var zoom: Double
    /// scrollTop / scrollHeight.
    public var at: Double
    public var left: Double
    public init(zoom: Double, at: Double, left: Double) { self.zoom = zoom; self.at = at; self.left = left }
}

/// A file in a library folder as the host knows it (MATH-22): nil = not known yet, `missing` = gone.
public enum PaperFileState: Equatable, Sendable { case file, folder, missing }

public protocol PaperHost: AnyObject {
    /// The ink changed (debounced 300 ms; flushed on close). The host writes it (library writeAnnotations /
    /// writePageAnnotations); `json` is the file's text exactly as Electron writes it.
    func paperMarksChanged(_ marks: PaperMarks, json: String)
    /// Read the ink for this paper (used when `load` is given none). nil: none.
    func paperReadAnnotations() -> PaperMarks?

    /// @bart from a highlight's note. The host asks Bart and, when it answers, calls `addAsk(page:markId:entry:)`;
    /// while it runs it keeps `pendingAsks` current. nil disables asking (no Bart row, no label).
    var paperCanAsk: Bool { get }
    func paperAsk(_ ask: PaperAsk)
    func paperStopAsk(_ askId: String)
    func paperDismissAsk(_ askId: String)
    /// Continue in project; false hides the button.
    var paperCanContinue: Bool { get }
    func paperContinue(_ c: PaperContinue)

    /// Copy text (⌘C on a pending selection or focused mark, an answer's Copy). nil: the pasteboard is written here.
    var paperCanCopy: Bool { get }
    func paperCopy(_ text: String)
    /// A link in an answer: never the app's window; the Stage opens it.
    func paperOpenLink(_ href: String)
    /// A library mention clicked; nil disables shown notes (a note is always its field).
    var paperOpensMentions: Bool { get }
    func paperOpenMention(_ id: String)
    /// A file mention clicked (MATH-22).
    func paperOpenFile(folderId: String, rel: String, name: String)
    /// A mentioned item's name now: .some(nil) when the library no longer holds it, nil when it cannot tell.
    func paperLibraryName(_ id: String) -> String??
    /// A citation's source as the library names it (cite.js libraryName); nil: none.
    func paperCitationSource(_ address: String) -> String?
    /// A mentioned file's state: nil until known.
    func paperFileState(folderId: String, rel: String) -> PaperFileState?
    /// The @ menu's rows for a query (lowercased); nil: notes have no menu.
    func paperMentionItems(_ query: String) -> [MentionRow]?
    /// One level of a library folder for the @ menu; nil: folders do not open.
    func paperListFolder(_ folderId: String, rel: String, done: @escaping (FolderListing) -> Void) -> Bool
    /// The @ menu opened or closed (the Stage keeps ⌘W from closing the tab meanwhile).
    func paperMentionMenu(open: Bool)

    /// Where the paper was read to, told when it closes.
    func paperView(_ state: PaperViewState)
    /// A find's result: matches and the active one (from 1).
    func paperFound(matches: Int, active: Int)
    /// A link's passage shown (or not: matches 0).
    func paperTarget(_ text: String, matches: Int, active: Int)
    /// Something could not be saved or opened.
    func paperError(_ message: String)
}

public extension PaperHost {
    func paperReadAnnotations() -> PaperMarks? { nil }
    var paperCanAsk: Bool { false }
    func paperAsk(_ ask: PaperAsk) {}
    func paperStopAsk(_ askId: String) {}
    func paperDismissAsk(_ askId: String) {}
    var paperCanContinue: Bool { false }
    func paperContinue(_ c: PaperContinue) {}
    var paperCanCopy: Bool { false }
    func paperCopy(_ text: String) {}
    func paperOpenLink(_ href: String) {}
    var paperOpensMentions: Bool { false }
    func paperOpenMention(_ id: String) {}
    func paperOpenFile(folderId: String, rel: String, name: String) {}
    func paperLibraryName(_ id: String) -> String?? { nil }
    func paperCitationSource(_ address: String) -> String? { nil }
    func paperFileState(folderId: String, rel: String) -> PaperFileState? { nil }
    func paperMentionItems(_ query: String) -> [MentionRow]? { nil }
    func paperListFolder(_ folderId: String, rel: String, done: @escaping (FolderListing) -> Void) -> Bool { false }
    func paperMentionMenu(open: Bool) {}
    func paperView(_ state: PaperViewState) {}
    func paperFound(matches: Int, active: Int) {}
    func paperTarget(_ text: String, matches: Int, active: Int) {}
    func paperError(_ message: String) {}
}
