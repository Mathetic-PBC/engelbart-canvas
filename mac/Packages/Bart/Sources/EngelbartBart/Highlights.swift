import Foundation
import EngelbartDoc
import EngelbartCore

// highlights.cjs — a pdf's ink as @bart is shown it (MATH-27, 2026-10-06): <stage>, the paper in front in the Stage
// with the page in view, and <highlights>, the papers the documents mention. Pure: Context reads the ink and finds the
// papers. Ink is the Stage's: { "<page>": [mark] }, a mark { id, rects, y, text, note, group, asks: [{ question, answer,
// … }] }. A free note is a mark without rects; it has no quote. A web page's ink (MATH-54) is the same file with a "web"
// list beside the pages; its <stage> and its entry in <highlights> say source="web". Build 3a: a web <stage> also carries
// the selection and the path of a picture (liveXml). Boxes (MATH-70): a mark with `box` is a rectangle over part of a web
// page, kept with a picture (`crop`, relative to the annotations folder) and the text under it, shown as <box crop="…">.
// An <ask> whose picture is not the box's current one says which it was: <ask crop="/abs/…png">.

public struct HighlightAsk: Equatable, Sendable { public var question: String, answer: String, crop: String? }

public struct Highlight: Equatable, Sendable {
    public var page: Int?
    public var box: Bool = false
    public var crop: String = ""
    public var quote: String = ""
    public var text: String = ""
    public var note: String = ""
    public var asks: [HighlightAsk] = []
}

/// A paper or web page whose highlights are shown (stageBlock, webStageBlock, mentionedBlock).
public struct InkedItem: Sendable {
    /// "web" for a web page; nil for a pdf.
    public var source: String?
    public var id: String?
    public var name: String
    /// A pdf's absolute path or address.
    public var where_: String = ""
    /// A web page's address and its saved copy's path.
    public var address: String = ""
    public var path: String = ""
    /// The folder to grant when the library does not hold it.
    public var dir: String?
    public var annotations: String = ""
    public var ink: JSONValue?
    public var inkRoot: String = ""
    public var selection: JSONValue?
    public var screenshot: String = ""
    public init(source: String? = nil, id: String? = nil, name: String, where_: String = "", address: String = "", path: String = "", dir: String? = nil,
                annotations: String = "", ink: JSONValue? = nil, inkRoot: String = "") {
        self.source = source; self.id = id; self.name = name; self.where_ = where_; self.address = address; self.path = path; self.dir = dir
        self.annotations = annotations; self.ink = ink; self.inkRoot = inkRoot
    }
}

public enum Highlights {
    static let quoteMax = 600 // a mark may hold whole pages (a selection across them)
    static let answerMax = 1500
    static let noteMax = 1500
    static let questionMax = 600
    static let boxTextMax = 2000
    public static let stageBudget = 6000
    public static let mentionedBudget = 14000
    static let moreRoom = "<more n=\"000000\"/>\n".jsLength
    /// shared/mark-answers.cjs WEB.
    public static let web = "web"
    /// browser/boxes.cjs CROP_RE.
    static let cropRE = JSRegex("^crops/([A-Za-z0-9_-]{1,64})\\.png$")

    /// An attribute's value: <, >, ", newlines as spaces, cut to `max`.
    public static func attrOf(_ value: String?, _ max: Int) -> String { JSRegex("[<>\"\\n\\r]", "g").replace(value ?? "", with: " ").jsSlice(0, max) }

    static func text(_ v: JSONValue?) -> String { v?.string?.jsTrim ?? "" }

    /// browser/boxes.cjs isBox: a mark with a `box` object.
    public static func isBox(_ m: JSONValue?) -> Bool { m?["box"]?.object != nil }

    /// A box's picture as an absolute path, from a mark's (or an ask's) `crop` under `inkRoot`; '' without one.
    public static func cropPath(_ m: JSONValue?, _ inkRoot: String) -> String {
        guard !inkRoot.isEmpty, let crop = m?["crop"]?.string, cropRE.test(crop) else { return "" }
        return (inkRoot as NSString).appendingPathComponent(crop)
    }

    static func asksOf(_ m: JSONValue, _ cropOf: ((JSONValue) -> String)? = nil) -> [HighlightAsk] {
        (m["asks"]?.array ?? []).filter { a in a.object != nil && (!text(a["question"]).isEmpty || !text(a["answer"]).isEmpty) }.map { a in
            let crop = cropOf?(a) ?? ""
            return HighlightAsk(question: text(a["question"]), answer: text(a["answer"]), crop: crop.isEmpty ? nil : crop)
        }
    }

    static func boxEntry(_ m: JSONValue, _ page: Int?, _ inkRoot: String) -> Highlight {
        Highlight(page: page, box: true, crop: cropPath(m, inkRoot), quote: "", text: text(m["text"]), note: text(m["note"]),
                  asks: asksOf(m) { a in
                      if let c = a["crop"]?.string, c != m["crop"]?.string { return cropPath(a, inkRoot) }
                      return ""
                  })
    }

    /// A pdf's ink → its highlights in page order, top to bottom. Marks sharing a `group` are one highlight. A mark with
    /// no text, note or ask is left out.
    public static func marksOf(_ ink: JSONValue?, inkRoot: String = "") -> [Highlight] {
        var parts: [(page: Int, y: Double, i: Int, m: JSONValue)] = []
        if let o = ink?.object {
            for (key, list) in o {
                // Number(key): "01" and " 2" are pages too, "web" is not.
                guard let d = Double(key.jsTrim), d == d.rounded(), d >= 1, d < 1e9, let items = list.array else { continue }
                let page = Int(d)
                for (i, m) in items.enumerated() where m.object != nil { parts.append((page, m["y"]?.double ?? 0, i, m)) }
            }
        }
        parts.sort { a, b in a.page != b.page ? a.page < b.page : a.y != b.y ? a.y < b.y : a.i < b.i }
        final class Entry { var page: Int; var quote: [String]; var note: [String]; var asks: [HighlightAsk]; var box: Highlight?
            init(page: Int, quote: [String], note: [String], asks: [HighlightAsk], box: Highlight? = nil) { self.page = page; self.quote = quote; self.note = note; self.asks = asks; self.box = box } }
        var out: [Entry] = []
        var grouped: [String: Entry] = [:]
        for (page, _, _, m) in parts {
            if isBox(m) { out.append(Entry(page: page, quote: [], note: [], asks: [], box: boxEntry(m, page, inkRoot))); continue }
            let quote = text(m["text"]), note = text(m["note"]), asks = asksOf(m)
            let group = m["group"]?.string.flatMap { $0.isEmpty ? nil : $0 }
            if let group, let held = grouped[group] {
                if !quote.isEmpty { held.quote.append(quote) }
                if !note.isEmpty { held.note.append(note) }
                held.asks += asks
                continue
            }
            let entry = Entry(page: page, quote: quote.isEmpty ? [] : [quote], note: note.isEmpty ? [] : [note], asks: asks)
            if let group { grouped[group] = entry }
            out.append(entry)
        }
        return out.map { e in e.box ?? Highlight(page: e.page, quote: e.quote.joined(separator: "\n"), note: e.note.joined(separator: "\n"), asks: e.asks) }
            .filter { $0.box || !$0.quote.isEmpty || !$0.note.isEmpty || !$0.asks.isEmpty }
    }

    /// A web page's ink → its highlights in the order the ink keeps them (the "web" list).
    public static func webMarksOf(_ ink: JSONValue?, inkRoot: String = "") -> [Highlight] {
        let list = ink?.object?[web]?.array ?? []
        return list.filter { $0.object != nil }.map { m in
            if isBox(m) { return boxEntry(m, nil, inkRoot) }
            let q = m["quote"]
            let quote = q?.object != nil ? text(q?["exact"]) : text(q)
            return Highlight(page: nil, quote: quote, note: text(m["note"]), asks: asksOf(m))
        }.filter { $0.box || !$0.quote.isEmpty || !$0.note.isEmpty || !$0.asks.isEmpty }
    }

    static func said(_ h: Highlight) -> Bool { !h.note.isEmpty || !h.asks.isEmpty }

    /// One highlight as a block; the parts it has none of are left out.
    public static func highlightXml(_ h: Highlight) -> String {
        var body: [String] = []
        if !h.quote.isEmpty { body.append("<quote>\n\(Clip.clipMiddle(h.quote, quoteMax))\n</quote>") }
        if h.box && !h.text.isEmpty { body.append("<text>\n\(Clip.clipMiddle(h.text, boxTextMax))\n</text>") }
        if !h.note.isEmpty { body.append("<note>\n\(Clip.clipMiddle(h.note, noteMax))\n</note>") }
        for a in h.asks {
            body.append("<ask\(a.crop.map { " crop=\"\(attrOf($0, 4096))\"" } ?? "")>\n<question>\n\(Clip.clipMiddle(a.question, questionMax))\n</question>\n<answer>\n\(Clip.clipMiddle(a.answer, answerMax))\n</answer>\n</ask>")
        }
        let tag = h.box ? "box" : "highlight"
        let attrs = "\(h.page.map { $0 != 0 ? " page=\"\($0)\"" : "" } ?? "")\(h.box && !h.crop.isEmpty ? " crop=\"\(attrOf(h.crop, 4096))\"" : "")"
        return body.isEmpty ? "<\(tag)\(attrs)/>\n" : "<\(tag)\(attrs)>\n\(body.joined(separator: "\n"))\n</\(tag)>\n"
    }

    struct Candidate { let h: Highlight; let at: Int; let xml: String; var n: Int = 0; let key: Int }

    /// Which candidates fit in `room` characters: each in turn when it still fits, those with a note or an ask first.
    static func take(_ candidates: [Candidate], _ room: Int) -> Set<Int> {
        var taken = Set<Int>()
        var left = room
        for c in candidates.filter({ said($0.h) }) + candidates.filter({ !said($0.h) }) {
            if c.xml.jsLength > left { continue }
            taken.insert(c.key)
            left -= c.xml.jsLength
        }
        return taken
    }

    static func moreLine(_ n: Int) -> String { n > 0 ? "<more n=\"\(n)\"/>\n" : "" }

    /// <stage paper="…" path="…" page="N" annotations="…"> the highlights of the paper in front </stage>, at most `budget`
    /// characters: the page in view first, then the nearest pages (the earlier of two as near), noted ones before bare
    /// ones; shown in page order with <more n="K"/>. No highlights: one line, highlights="0".
    public static func stageBlock(_ paper: InkedItem, page: Int?, ink: JSONValue?, budget: Int = stageBudget) -> String {
        let at = (page ?? 0) > 0 ? page! : 1
        let attrs = "paper=\"\(attrOf(paper.name, 200))\" path=\"\(attrOf(paper.where_, 4096))\" page=\"\(at)\""
        let list = marksOf(ink, inkRoot: paper.inkRoot)
        if list.isEmpty { return "<stage \(attrs) highlights=\"0\"/>" }
        let open = "<stage \(attrs) annotations=\"\(attrOf(paper.annotations, 4096))\">\n", close = "</stage>"
        let candidates = list.enumerated().map { Candidate(h: $0.element, at: $0.offset, xml: highlightXml($0.element), key: $0.offset) }
            .sorted { a, b in
                let da = abs((a.h.page ?? 0) - at), db = abs((b.h.page ?? 0) - at)
                if da != db { return da < db }
                if a.h.page != b.h.page { return (a.h.page ?? 0) < (b.h.page ?? 0) }
                return a.at < b.at
            }
        let taken = take(candidates, budget - open.jsLength - close.jsLength - moreRoom)
        let shown = candidates.filter { taken.contains($0.key) }.sorted { $0.at < $1.at }
        return open + shown.map { $0.xml }.joined() + moreLine(list.count - shown.count) + close
    }

    static func webAttrs(_ page: InkedItem) -> String {
        "source=\"web\" title=\"\(attrOf(page.name, 200))\" address=\"\(attrOf(page.address, 4096))\"\(page.path.isEmpty ? "" : " path=\"\(attrOf(page.path, 4096))\"")"
    }

    /// The person's selection on the web page in front and a picture of it, as they are now; '' for neither.
    public static func liveXml(selection: JSONValue?, screenshot: String) -> String {
        let exact = text(selection?["quote"]?["exact"]), around = text(selection?["pageText"])
        var parts: [String] = []
        if !exact.isEmpty { parts.append("<selection>\n<quote>\n\(exact)\n</quote>\n\(around.isEmpty ? "" : "<page_text>\n\(around)\n</page_text>\n")</selection>\n") }
        if !screenshot.isEmpty { parts.append("<screenshot path=\"\(attrOf(screenshot, 4096))\"/>\n") }
        return parts.joined()
    }

    /// <stage source="web" …> the highlights of the web page in front </stage>: noted ones first, in ink order; live parts
    /// first and outside the budget. No highlights: highlights="0" (one line when nothing is live either).
    public static func webStageBlock(_ page: InkedItem, ink: JSONValue?, budget: Int = stageBudget) -> String {
        let attrs = webAttrs(page)
        let list = webMarksOf(ink, inkRoot: page.inkRoot)
        let live = liveXml(selection: page.selection, screenshot: page.screenshot)
        if list.isEmpty { return live.isEmpty ? "<stage \(attrs) highlights=\"0\"/>" : "<stage \(attrs) highlights=\"0\">\n\(live)</stage>" }
        let open = "<stage \(attrs)\(page.annotations.isEmpty ? "" : " annotations=\"\(attrOf(page.annotations, 4096))\"")>\n", close = "</stage>"
        let candidates = list.enumerated().map { Candidate(h: $0.element, at: $0.offset, xml: highlightXml($0.element), key: $0.offset) }
        let taken = take(candidates, budget - open.jsLength - close.jsLength - moreRoom)
        let shown = candidates.filter { taken.contains($0.key) }
        return open + live + shown.map { $0.xml }.joined() + moreLine(list.count - shown.count) + close
    }

    static func mentionedItem(_ item: InkedItem) -> (list: [Highlight], head: String, tail: String) {
        if item.source == web {
            return (webMarksOf(item.ink, inkRoot: item.inkRoot), "<page \(webAttrs(item)) annotations=\"\(attrOf(item.annotations, 4096))\">\n", "</page>\n")
        }
        return (marksOf(item.ink, inkRoot: item.inkRoot), "<paper name=\"\(attrOf(item.name, 200))\" path=\"\(attrOf(item.where_, 4096))\" annotations=\"\(attrOf(item.annotations, 4096))\">\n", "</paper>\n")
    }

    /// <highlights from="mentioned"> each mentioned item that has highlights </highlights>, sharing `budget`: noted ones
    /// first, then each item's first, second… highlight in turn; '' when none has any.
    public static func mentionedBlock(_ papers: [InkedItem], budget: Int = mentionedBudget) -> String {
        let open = "<highlights from=\"mentioned\">\n", close = "</highlights>"
        var room = budget - open.jsLength - close.jsLength
        var held: [(head: String, tail: String, list: [Highlight], candidates: [Candidate])] = []
        var key = 0
        for paper in papers {
            let (list, head, tail) = mentionedItem(paper)
            if list.isEmpty { continue }
            let frame = head.jsLength + tail.jsLength + moreRoom
            if frame > room { continue }
            room -= frame
            let n = held.count
            let cands = list.enumerated().map { e -> Candidate in key += 1; return Candidate(h: e.element, at: e.offset, xml: highlightXml(e.element), n: n, key: key) }
            held.append((head, tail, list, cands))
        }
        if held.isEmpty { return "" }
        let candidates = held.flatMap { $0.candidates }.sorted { a, b in a.at != b.at ? a.at < b.at : a.n < b.n }
        let taken = take(candidates, room)
        let body = held.map { p -> String in
            let shown = p.candidates.filter { taken.contains($0.key) }.sorted { $0.at < $1.at }
            return p.head + shown.map { $0.xml }.joined() + moreLine(p.list.count - shown.count) + p.tail
        }
        return open + body.joined() + close
    }
}
