import Foundation
import EngelbartDoc
import EngelbartEditor
import EngelbartCore
import EngelbartStage

/// An `@bart` line for the router (the editor's RouteRequest, whose initializer is the Editor's own).
public struct RouteAsk {
    public var askId: String
    public var text: String
    public var inputs: Route.Inputs
    public var rule: Route.Rule?
    public var placeLine: Int
    public var placeText: String
    public var level: (name: String, effort: String)?
    public init(askId: String, text: String, inputs: Route.Inputs, rule: Route.Rule? = nil, placeLine: Int = 0, placeText: String = "", level: (name: String, effort: String)? = nil) {
        self.askId = askId; self.text = text; self.inputs = inputs; self.rule = rule; self.placeLine = placeLine; self.placeText = placeText; self.level = level
    }
    public init(_ r: RouteRequest) { self.init(askId: r.askId, text: r.text, inputs: r.inputs, rule: r.rule, placeLine: r.placeLine, placeText: r.placeText, level: r.level) }
}

/// The page in front on the Stage (Stage.jsx onPage; the Stage's StagePage): its address or path, a web pdf's bytes, the tab.
public struct OpenPage: Equatable {
    public var input: String
    public var title: String
    public var bytes: Data?
    public var tabId: String
    public var webPage: Bool
    public init(input: String, title: String, bytes: Data? = nil, tabId: String = "", webPage: Bool = false) {
        self.input = input; self.title = title; self.bytes = bytes; self.tabId = tabId; self.webPage = webPage
    }
    public init(_ p: StagePage) { self.init(input: p.input, title: p.title, bytes: p.bytes, tabId: p.tabId, webPage: p.webPage) }
}

/// What a pdf view on the Stage is made from (the Stage's StagePDFRequest).
public struct PaperRequest {
    public var bytes: Data
    public var marks: JSONValue
    public var target: String?, targetTo: String?, targetPage: Int?
    public var initialSection: (find: String, to: String)?
    public var viewState: JSONValue?
    public var rowId: String?
    public var url: String
    public var name: String
    public var pendingAsks: [JSONValue]
    public var canAsk: Bool
    public var onView: (JSONValue) -> Void = { _ in }
    public var onTarget: (String, (matches: Int, active: Int)?) -> Void = { _, _ in }
    public var onFind: ((matches: Int, active: Int)?) -> Void = { _ in }
    public var onMarksChange: (JSONValue) -> Void = { _ in }
    public var onOpenLink: (String) -> Void = { _ in }
    public init(bytes: Data = Data(), marks: JSONValue = [:], rowId: String?, url: String, name: String, pendingAsks: [JSONValue] = [], canAsk: Bool = true) {
        self.bytes = bytes; self.marks = marks; self.rowId = rowId; self.url = url; self.name = name; self.pendingAsks = pendingAsks; self.canAsk = canAsk
    }
    public init(_ r: StagePDFRequest) {
        self.init(bytes: r.bytes, marks: r.marks, rowId: r.rowId, url: r.url, name: r.name, pendingAsks: r.pendingAsks, canAsk: r.onAsk != nil)
        target = r.target; targetTo = r.targetTo; targetPage = r.targetPage
        initialSection = r.initialSection.map { ($0.find, $0.to) }
        viewState = r.viewState
        onView = r.onView; onTarget = r.onTarget; onFind = r.onFind; onMarksChange = r.onMarksChange; onOpenLink = r.onOpenLink
    }
}

/// A Build to start from a line (the editor's BuildRequest): in place of `askId`'s pending line, or after line `after`.
public struct BuildAsk {
    public var text: String
    public var askId: String?
    public var routedFrom: String?
    public var after: Int?
    public var afterLine: String?
    public var placeLine: Int
    public var placeText: String
    public init(text: String, askId: String? = nil, routedFrom: String? = nil, after: Int? = nil, afterLine: String? = nil, placeLine: Int = 0, placeText: String = "") {
        self.text = text; self.askId = askId; self.routedFrom = routedFrom; self.after = after; self.afterLine = afterLine; self.placeLine = placeLine; self.placeText = placeText
    }
    public init(_ b: BuildRequest) { self.init(text: b.text, askId: b.askId, routedFrom: b.routedFrom, after: b.after, afterLine: b.afterLine, placeLine: b.placeLine, placeText: b.placeText) }
}
