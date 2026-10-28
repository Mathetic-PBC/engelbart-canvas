import Foundation
import EngelbartCore
import EngelbartDoc

// What the editor hands the outside and takes from it (DocEditor.jsx props: onAsk, onRoute, onBuild, asks, builds, …).

/// A selection in the document: ends in lineText() offsets (the editor's caretInfo), anchor where it began.
public struct DocSelection: Equatable, Sendable {
    public var anchor: DocPoint
    public var focus: DocPoint
    public init(anchor: DocPoint, focus: DocPoint) { self.anchor = anchor; self.focus = focus }
    public init(line: Int, offset: Int) { anchor = DocPoint(line: line, offset: offset); focus = anchor }
    public init(line: Int, _ a: Int, _ b: Int) { anchor = DocPoint(line: line, offset: a); focus = DocPoint(line: line, offset: b) }
    public var start: DocPoint { min(anchor, focus) }
    public var end: DocPoint { max(anchor, focus) }
    public var sameLine: Bool { anchor.line == focus.line }
    public var collapsed: Bool { anchor == focus }
    public var backward: Bool { focus < anchor }
}

/// Where the caret goes once an edit is drawn: a place, or a range on one line (`back`: made backwards).
public struct CaretPlace: Equatable, Sendable {
    public var line: Int
    public var a: Int
    public var b: Int
    public var back = false
    public init(line: Int, offset: Int) { self.line = line; a = offset; b = offset }
    public init(line: Int, sel: (Int, Int), back: Bool = false) { self.line = line; a = sel.0; b = sel.1; self.back = back }
}

/// A turn of a conversation as a follow-up sends it: what was asked, what was said, who said it.
public struct AskedTurn: Equatable, Sendable {
    public var question: String
    public var answer: String
    public var agent: String?
    public init(question: String, answer: String, agent: String? = nil) { self.question = question; self.answer = answer; self.agent = agent }
}

/// props.onAsk's argument: a question handed to the window, with the id of the pending line put under it.
public struct AskRequest: Equatable, Sendable {
    public var askId: String
    public var text: String
    public var turns: [AskedTurn]
    /// 'bart' (Chat), 'router', 'brainstorm', 'discover', 'create'.
    public var agent: String
    /// Where its line was: the Agent Viewer finds it again by these.
    public var placeLine: Int
    public var placeText: String
    /// It starts a conversation whose title line waits to be named.
    public var name = false
    /// A model and effort for this run (Regenerate's selector).
    public var choice: (model: String, effort: String)? = nil
    /// Bart handed it over: { id, by, error, build, corrected }.
    public var routed: JSONValue? = nil
    public var refine = false
    public var research = false
    /// A running search adjusted: { after, words } or { after, level }.
    public var steer: JSONValue? = nil
    public init(askId: String, text: String, turns: [AskedTurn], agent: String, placeLine: Int, placeText: String) {
        self.askId = askId; self.text = text; self.turns = turns; self.agent = agent; self.placeLine = placeLine; self.placeText = placeText
    }
    public static func == (a: AskRequest, b: AskRequest) -> Bool {
        a.askId == b.askId && a.text == b.text && a.turns == b.turns && a.agent == b.agent && a.placeLine == b.placeLine && a.placeText == b.placeText
            && a.name == b.name && a.choice?.model == b.choice?.model && a.choice?.effort == b.choice?.effort && a.routed == b.routed
            && a.refine == b.refine && a.research == b.research && a.steer == b.steer
    }
}

/// props.onRoute's argument: an `@bart` line for the router to pick an agent for.
public struct RouteRequest: Equatable, Sendable {
    public var askId: String
    public var text: String
    public var inputs: Route.Inputs
    public var rule: Route.Rule?
    public var placeLine: Int
    public var placeText: String
    /// What the pending row names while Bart routes it.
    public var level: (name: String, effort: String)?
    public static func == (a: RouteRequest, b: RouteRequest) -> Bool { a.askId == b.askId && a.text == b.text && a.inputs == b.inputs && a.rule == b.rule && a.placeLine == b.placeLine && a.placeText == b.placeText }
}

/// The router's answer: { agent: 'chat'|'brainstorm'|'discover'|'create'|'build', sure, by, rule, spec, id, error }.
public struct RoutePick: Equatable, Sendable {
    public var agent: String
    public var sure: Double
    public var by: String
    public var rule: String?
    public var spec: Bool
    public var id: String?
    public var error: String?
    public init(agent: String, sure: Double = 0, by: String = "none", rule: String? = nil, spec: Bool = false, id: String? = nil, error: String? = nil) {
        self.agent = agent; self.sure = sure; self.by = by; self.rule = rule; self.spec = spec; self.id = id; self.error = error
    }
}

/// props.onBuild's argument: a Build to start from `text`, its card on its own line after `after`, or in place of `askId`'s pending line.
public struct BuildRequest: Equatable, Sendable {
    public var text: String
    public var askId: String?
    public var routedFrom: String?
    public var after: Int?
    public var afterLine: String?
    public var placeLine: Int
    public var placeText: String
}

/// A run at work, as the window keeps it (DocEditor askStarted/askProgressed; Workspace `asks`).
public struct AskProgress: Equatable, Sendable {
    public var agent: String?
    public var activity: String
    public var name: String
    public var effort: String
    public var movedUp: Bool
    /// The answer so far.
    public var lines: [String]
    /// The things done (at most 60).
    public var log: [String]
    /// What a Create run said it is making (main/bart/making.cjs, ask.making).
    public var making: String = ""
    /// When it was asked (ask.at): a Create row's m:ss.
    public var at: Date? = nil
    public init(agent: String? = nil, activity: String = "", name: String = "", effort: String = "", movedUp: Bool = false, lines: [String] = [], log: [String] = [], making: String = "", at: Date? = nil) {
        self.agent = agent; self.activity = activity; self.name = name; self.effort = effort; self.movedUp = movedUp; self.lines = lines; self.log = log
        self.making = making; self.at = at
    }

    /// A step beginning drops what the last step showed; a thing done is kept in `log` (60 at most).
    public func progressed(step: Bool = false, name: String? = nil, effort: String? = nil, movedUp: Bool? = nil, activity: String? = nil, lines: [String]? = nil, log: Bool = false) -> AskProgress {
        var next = self
        if let movedUp { next.movedUp = movedUp }
        if let activity { next.activity = activity }
        if let lines { next.lines = lines }
        if step { next.activity = activity ?? ""; next.lines = lines ?? []; next.name = name ?? ""; next.effort = effort ?? "" }
        if log, let activity, !activity.isEmpty { next.log = Array((self.log + [activity]).suffix(60)) }
        return next
    }
}

/// What a Build's record says, as far as the editor reads it: its status and whether it is closed.
public struct BuildState: Equatable, Sendable {
    public var status: String
    public var final: Bool
    public init(status: String, final: Bool = false) { self.status = status; self.final = final }
    static let DONE: Set<String> = ["accepted", "discarded", "failed", "stopped"]
    public var done: Bool { final || BuildState.DONE.contains(status) }
}

/// A key the editor handles (editorKey): its name as the DOM's `e.key` spells it, and its modifiers.
public struct KeyPress: Equatable, Sendable {
    public var key: String
    public var shift = false
    public var cmd = false
    public var alt = false
    public var composing = false
    public init(_ key: String, shift: Bool = false, cmd: Bool = false, alt: Bool = false, composing: Bool = false) {
        self.key = key; self.shift = shift; self.cmd = cmd; self.alt = alt; self.composing = composing
    }
}

/// A position kept for where a document was scrolled to (captureView): the first line on screen, how far its top sits
/// above the pane's top, a hash of its text; `top` the raw offset for when that line is gone.
public struct ViewPosition: Equatable, Codable, Sendable {
    public var top: Double
    public var line: Int?
    public var offset: Double?
    public var hash: String?
    public init(top: Double, line: Int? = nil, offset: Double? = nil, hash: String? = nil) { self.top = top; self.line = line; self.offset = offset; self.hash = hash }
}

public enum EditorText {
    /// A short fingerprint of a line (FNV-1a over UTF-16 units, base 36), so a remembered position finds its line again.
    public static func hashLine(_ line: String) -> String {
        var h: UInt32 = 0x811c9dc5
        for u in line.utf16 { h ^= UInt32(u); h = h &* 0x01000193 }
        return String(h, radix: 36)
    }

    /// A new ask's id: the time in base 36, a dash, eight random base-36 characters.
    public static func newAskId(now: Date = Date()) -> String {
        let t = String(Int64(now.timeIntervalSince1970 * 1000), radix: 36)
        let chars = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        return t + "-" + String((0..<8).map { _ in chars.randomElement()! })
    }

    /// A follow-up's text with each [Attachment n] whose image saved written as an image token.
    public static func withAttachments(_ text: String, _ images: [(n: Int, id: String?)]) -> String {
        var ids: [Int: String] = [:]
        for image in images { if let id = image.id { ids[image.n] = id } }
        return Rx(#"(?<!!)\[Attachment (\d+)\](?!\()"#).replace(text) { m in
            if let n = Int(m[1]!), let id = ids[n] { return "![Attachment \(n)](img:\(id))" }
            return m.str
        }
    }

    /// An image line's alt text carries its width after a bar (`Attachment 1|w=320`).
    public static func imgParts(_ text: String) -> (name: String, width: Int) {
        if let m = Rx(#"^(.*)\|w=(\d+)$"#).match(text) { return (m[1] ?? "", Int(m[2]!) ?? 0) }
        return (text, 0)
    }

    /// m:ss since `at`.
    public static func clockOf(_ at: Date?, now: Date = Date()) -> String {
        let s = max(0, Int(now.timeIntervalSince(at ?? now)))
        return "\(s / 60):\(String(format: "%02d", s % 60))"
    }
}
