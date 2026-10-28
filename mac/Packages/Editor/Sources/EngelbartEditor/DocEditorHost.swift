import AppKit
import EngelbartCore
import EngelbartDoc

/// A row of what the document can mention (props.mentionable): a library row with what its hover card says.
public struct EditorRow: Equatable {
    public var row: LibRow
    /// The card's title (an agent's "Bart"), else the row's name.
    public var title: String?
    /// The card's grey footnote line ("reads, never edits").
    public var facts: String?
    /// A note in the trash (MATH-58): drawn grey, still opened.
    public var trashed: Bool
    public init(row: LibRow, title: String? = nil, facts: String? = nil, trashed: Bool = false) { self.row = row; self.title = title; self.facts = facts; self.trashed = trashed }
}

/// What a library folder opened in the @ menu holds (listFolder's answer).
public struct FolderListing: Equatable {
    public struct Entry: Equatable { public var name: String; public var rel: String; public var dir: Bool; public var type: String?
        public init(name: String, rel: String, dir: Bool, type: String? = nil) { self.name = name; self.rel = rel; self.dir = dir; self.type = type } }
    public var entries: [Entry]
    public var error: String?
    public init(entries: [Entry], error: String? = nil) { self.entries = entries; self.error = error }
}

/// The editor's one door to the outside (DocEditor.jsx's props). Every method has a default, so an embedder (a post-it's
/// small editor) implements only what it uses. All calls come on the main thread.
public protocol DocEditorHost: AnyObject {
    // The document
    /// Every edit, at once (props.onChange): the window's copy of the text.
    func docEditor(_ editor: DocEditorView, changed text: String)
    /// The document to disk, 400 ms after typing stops and when it is left (autosave).
    func docEditor(_ editor: DocEditorView, save text: String, key: String)
    /// Another document's text, for a run handed on after the person left it (props.docTextOf).
    func docEditor(_ editor: DocEditorView, textOf key: String) -> String?
    /// Another document changed (a run handed on in a document no longer shown).
    func docEditor(_ editor: DocEditorView, change key: String, text: String)

    // What the document mentions
    func docEditorMentionable(_ editor: DocEditorView) -> [EditorRow]
    /// The @ menu's rows for `query` (model/rail.js mentionRows: verbs, Note, the open page, workspaces, the library); nil:
    /// the mentionable rows by name.
    func docEditor(_ editor: DocEditorView, mentionItems query: String) -> [MenuItem]?
    func docEditor(_ editor: DocEditorView, listFolder id: String, rel: String, done: @escaping (FolderListing) -> Void)
    func docEditor(_ editor: DocEditorView, fileState folderId: String, rel: String) -> FileState
    func docEditor(_ editor: DocEditorView, picked row: MenuItem)
    func docEditor(_ editor: DocEditorView, mentionMenuOpen open: Bool)
    /// `@Note name` + Enter: make the note; its name comes back (nil: none made).
    func docEditor(_ editor: DocEditorView, makeNote name: String, done: @escaping (String?) -> Void)

    // Agents
    func docEditorModels(_ editor: DocEditorView) -> QuestionModels?
    /// nil: this editor cannot ask (no send, no reply fields).
    func docEditorCanAsk(_ editor: DocEditorView) -> Bool
    func docEditor(_ editor: DocEditorView, ask: AskRequest)
    /// The router; nil from `docEditorHasRouter` false means lines are asked of Chat.
    func docEditorHasRouter(_ editor: DocEditorView) -> Bool
    func docEditor(_ editor: DocEditorView, route: RouteRequest, done: @escaping (RoutePick?) -> Void)
    func docEditor(_ editor: DocEditorView, routeGone askId: String)
    func docEditor(_ editor: DocEditorView, stop askId: String)
    func docEditorCanBuild(_ editor: DocEditorView) -> Bool
    func docEditor(_ editor: DocEditorView, build: BuildRequest)
    /// A Build's card for a `build> <id>` line (the Build package's view), or nil.
    func docEditor(_ editor: DocEditorView, buildView id: String) -> NSView?

    // Opening things
    func docEditor(_ editor: DocEditorView, openLink href: String, newTab: Bool, sections: [String]?)
    func docEditor(_ editor: DocEditorView, open row: LibRow)
    /// A note's or workspace's mention clicked: its document beside this one (MATH-23).
    func docEditor(_ editor: DocEditorView, openBeside kind: String, id: String, name: String)
    func docEditor(_ editor: DocEditorView, openWorkspace id: String)
    func docEditor(_ editor: DocEditorView, openFile folderId: String, rel: String, name: String, newTab: Bool)
    func docEditor(_ editor: DocEditorView, openZotero key: String, name: String, newTab: Bool)
    func docEditor(_ editor: DocEditorView, openMade key: String)

    // Pictures and drops
    /// A pasted picture's file by its id (img:<id>), drawn on its line.
    func docEditor(_ editor: DocEditorView, image id: String) -> NSImage?
    /// A pasted picture saved as `label` ("Attachment n"); its id comes back (nil: not saved).
    func docEditor(_ editor: DocEditorView, pasteImage data: Data, mime: String, label: String, done: @escaping (String?) -> Void)
    func docEditor(_ editor: DocEditorView, dropItems: [Drop.Item])
    func docEditor(_ editor: DocEditorView, dropOnZotero key: String, name: String, file: String)

    // Clipboard, places, errors
    func docEditor(_ editor: DocEditorView, copy text: String)
    func docEditor(_ editor: DocEditorView, viewOf scope: String, key: String) -> ViewPosition?
    func docEditor(_ editor: DocEditorView, reportView position: ViewPosition, scope: String, key: String, now: Bool)
    func docEditor(_ editor: DocEditorView, error: Error)
}

public extension DocEditorHost {
    func docEditor(_ editor: DocEditorView, changed text: String) {}
    func docEditor(_ editor: DocEditorView, save text: String, key: String) {}
    func docEditor(_ editor: DocEditorView, textOf key: String) -> String? { nil }
    func docEditor(_ editor: DocEditorView, change key: String, text: String) {}
    func docEditorMentionable(_ editor: DocEditorView) -> [EditorRow] { [] }
    func docEditor(_ editor: DocEditorView, mentionItems query: String) -> [MenuItem]? { nil }
    func docEditor(_ editor: DocEditorView, listFolder id: String, rel: String, done: @escaping (FolderListing) -> Void) { done(FolderListing(entries: [], error: "This folder could not be read")) }
    func docEditor(_ editor: DocEditorView, fileState folderId: String, rel: String) -> FileState { .unknown }
    func docEditor(_ editor: DocEditorView, picked row: MenuItem) {}
    func docEditor(_ editor: DocEditorView, mentionMenuOpen open: Bool) {}
    func docEditor(_ editor: DocEditorView, makeNote name: String, done: @escaping (String?) -> Void) { done(nil) }
    func docEditorModels(_ editor: DocEditorView) -> QuestionModels? { nil }
    func docEditorCanAsk(_ editor: DocEditorView) -> Bool { false }
    func docEditor(_ editor: DocEditorView, ask: AskRequest) {}
    func docEditorHasRouter(_ editor: DocEditorView) -> Bool { false }
    func docEditor(_ editor: DocEditorView, route: RouteRequest, done: @escaping (RoutePick?) -> Void) { done(nil) }
    func docEditor(_ editor: DocEditorView, routeGone askId: String) {}
    func docEditor(_ editor: DocEditorView, stop askId: String) {}
    func docEditorCanBuild(_ editor: DocEditorView) -> Bool { false }
    func docEditor(_ editor: DocEditorView, build: BuildRequest) {}
    func docEditor(_ editor: DocEditorView, buildView id: String) -> NSView? { nil }
    func docEditor(_ editor: DocEditorView, openLink href: String, newTab: Bool, sections: [String]?) { if let u = URL(string: href) { NSWorkspace.shared.open(u) } }
    func docEditor(_ editor: DocEditorView, open row: LibRow) {}
    func docEditor(_ editor: DocEditorView, openBeside kind: String, id: String, name: String) {}
    func docEditor(_ editor: DocEditorView, openWorkspace id: String) {}
    func docEditor(_ editor: DocEditorView, openFile folderId: String, rel: String, name: String, newTab: Bool) {}
    func docEditor(_ editor: DocEditorView, openZotero key: String, name: String, newTab: Bool) {}
    func docEditor(_ editor: DocEditorView, openMade key: String) {}
    func docEditor(_ editor: DocEditorView, image id: String) -> NSImage? { nil }
    func docEditor(_ editor: DocEditorView, pasteImage data: Data, mime: String, label: String, done: @escaping (String?) -> Void) { done(nil) }
    func docEditor(_ editor: DocEditorView, dropItems: [Drop.Item]) {}
    func docEditor(_ editor: DocEditorView, dropOnZotero key: String, name: String, file: String) {}
    func docEditor(_ editor: DocEditorView, copy text: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string) }
    func docEditor(_ editor: DocEditorView, viewOf scope: String, key: String) -> ViewPosition? { nil }
    func docEditor(_ editor: DocEditorView, reportView position: ViewPosition, scope: String, key: String, now: Bool) {}
    func docEditor(_ editor: DocEditorView, error: Error) {}
}
