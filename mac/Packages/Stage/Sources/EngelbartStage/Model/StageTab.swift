import Foundation
import EngelbartCore

/// What the host's page reports (Electron's `browser:state`).
public struct PageState: Equatable, Sendable {
    public var id: String
    public var url: String
    public var title: String = ""
    public var loading = false
    public var canGoBack = false
    public var canGoForward = false
    public var error: PageError?
    /// A page has arrived in this tab at least once (the Stage's "Waking…" waits for the first).
    public var drawn = false
    public init(id: String, url: String, title: String = "", loading: Bool = false, canGoBack: Bool = false, canGoForward: Bool = false, error: PageError? = nil, drawn: Bool = false) {
        self.id = id; self.url = url; self.title = title; self.loading = loading; self.canGoBack = canGoBack
        self.canGoForward = canGoForward; self.error = error; self.drawn = drawn
    }
}

public struct PageError: Equatable, Sendable {
    public var code: Int
    public var description: String
    public var url: String
    public init(code: Int, description: String, url: String) { self.code = code; self.description = description; self.url = url }
}

/// What the host read at a path (src/main/stage/files.cjs readStageFile).
public struct StageFile: Equatable, Sendable {
    public enum Kind: String, Sendable { case folder, pdf, page, doc, md, table, image, text, unsupported, loading, error }
    public var kind: Kind
    public var path: String
    public var name: String
    public var url: String?
    public var bytes: Data?
    public var mime: String?
    public var text: String?
    public var truncated = false
    public var delimiter: String?
    public var ext: String?
    public var message: String?
    public init(kind: Kind, path: String, name: String, url: String? = nil, bytes: Data? = nil, mime: String? = nil, text: String? = nil,
                truncated: Bool = false, delimiter: String? = nil, ext: String? = nil, message: String? = nil) {
        self.kind = kind; self.path = path; self.name = name; self.url = url; self.bytes = bytes; self.mime = mime; self.text = text
        self.truncated = truncated; self.delimiter = delimiter; self.ext = ext; self.message = message
    }
}

/// A tab's pdf: from the web (the page that led to it is `under`), from disk or from the library (`rowId`).
public struct StagePDF: Equatable, Sendable {
    public var url: String
    public var input: String
    public var name: String
    public var under = "about:blank"
    public var seq = 0
    public var loading = false
    public var bytes: Data?
    public var error = ""
    /// The ink; nil until read (Electron's `undefined`).
    public var marks: JSONValue?
    public var rowId: String?
    /// The viewer's place (page, zoom), kept while the tab is behind.
    public var view: JSONValue?
    public init(url: String, input: String, name: String, under: String = "about:blank", seq: Int = 0, loading: Bool = false,
                bytes: Data? = nil, error: String = "", marks: JSONValue? = nil, rowId: String? = nil) {
        self.url = url; self.input = input; self.name = name; self.under = under; self.seq = seq; self.loading = loading
        self.bytes = bytes; self.error = error; self.marks = marks; self.rowId = rowId
    }
}

/// What a tab is kept as across relaunches (MATH-10): a library row or a place.
public struct KeptTab: Equatable, Sendable {
    public var item: String?
    public var address: String?
    public var title: String
    public init(item: String? = nil, address: String? = nil, title: String = "") { self.item = item; self.address = address; self.title = title }
    public var json: JSONValue {
        if let item { return ["item": .string(item), "title": .string(title)] }
        return ["address": .string(address ?? ""), "title": .string(title)]
    }
    public init?(json: JSONValue) {
        guard case .object(let o) = json else { return nil }
        item = o["item"]?.string; address = o["address"]?.string; title = o["title"]?.string ?? ""
        if item == nil && address == nil { return nil }
    }
}

/// The Stage's tabs as the host keeps them: `{ active, tabs }`.
public struct StageSnapshot: Equatable, Sendable {
    public var active: Int
    public var tabs: [KeptTab]
    public init(active: Int = 0, tabs: [KeptTab] = []) { self.active = active; self.tabs = tabs }
    public var json: JSONValue { ["active": .number(Double(active)), "tabs": .array(tabs.map(\.json))] }
    public init(json: JSONValue?) {
        active = json?["active"]?.int ?? 0
        tabs = (json?["tabs"]?.array ?? []).compactMap(KeptTab.init(json:))
    }
}

/// A section an @discover guide suggested (2026-10-03).
public struct GuideSection: Equatable, Sendable {
    public var label: String
    public var find: String
    public var to: String
    public init(label: String, find: String, to: String) { self.label = label; self.find = find; self.to = to }
}

/// One Stage tab, as Stage.jsx's state holds it.
public struct StageTab: Equatable, Sendable {
    public var id: String
    public var url = "about:blank"
    public var web: PageState?
    public var item: String?
    public var row: StageRow?
    public var file: StageFile?
    public var pdf: StagePDF?
    public var pdfForward: StagePDF?
    public var pendingFind: String?
    public var pendingTo: String?
    public var pendingPage: Int?
    public var sections: [GuideSection]?
    public var activeSection = -1
    /// Something is on its way into it (placeTab never reuses it).
    public var claimed = false
    /// A page opened it (adopt): it is a page whatever its address.
    public var opened = false
    /// The tab a page in it was opened from (a sign-in): closing goes back there.
    public var from: String?
    /// Given back after a relaunch, not shown yet.
    public var restore: KeptTab?
    public var restoreOpening = false

    public init(id: String = IDs.new()) { self.id = id }
    public static func blank() -> StageTab { StageTab() }
}
