import Foundation
import EngelbartCore
import CoreGraphics

// The editor's smaller pure models: paste.js (text from a PDF), doc-find.js and find.js (find), doc-sync.js (one
// document in several windows), key-side.js (where ⌘T/⌘W/⌘F go), drop.js (what a drop holds), shared/selection-card.cjs,
// shared/mark-answers.cjs and markdown.js (a markdown file read on the Stage).

// MARK: paste.js

/// Text copied out of a PDF (MATH-24, 2026-10-06) comes with the page's layout in it; pdfText takes it back out.
public enum PdfPaste {
    static let LIGATURES: [Character: String] = ["\u{FB00}": "ff", "\u{FB01}": "fi", "\u{FB02}": "fl", "\u{FB03}": "ffi", "\u{FB04}": "ffl", "\u{FB05}": "st", "\u{FB06}": "st"]
    static let ITEM = Rx(#"^(?:[•◦▪▫●○‣∙·\-–—*]\s|\(?\d{1,3}[.)]\s|\(?[a-z][.)]\s|\(\d{1,3}\)\s|\[\d{1,3}\]\s)"#)
    static let END = Rx(#"[.!?:;]["'”’)\]]*$"#)
    static let SPLIT = Rx(#"[A-Za-zÀ-ɏ]-$"#)
    static let PAGE_NUMBER = Rx(#"^(?:\d{1,4}|[ivxlc]{1,6})$"#, "i")

    static func median(_ ns: [Int]) -> Int { let s = ns.sorted(); return s.isEmpty ? 0 : s[s.count / 2] }

    /// The characters a PDF copies that no one typed: ligatures as their letters, soft hyphens gone, odd spaces as spaces.
    public static func pdfChars(_ text: String?) -> String {
        var s = Rx(#"\r\n?"#).replace(text ?? "", with: "\n")
        s = String(s.flatMap { c -> String in LIGATURES[c] ?? String(c) })
        s = s.replacingOccurrences(of: "\u{00AD}", with: "")
        return Rx("[\u{00A0}\u{2007}\u{202F}\u{2009}]").replace(s, with: " ")
    }

    static func hardWrapped(_ lines: [String]) -> Bool {
        let full = lines.filter { !$0.trimmed.isEmpty }
        if full.count < 2 || lines.contains(where: { Rx(#"^\s*(```|~~~)"#).test($0) }) { return false }
        if full.filter({ Rx(#"^(?: {4}|\t)"#).test($0) }).count > 1 { return false }
        if median(full.map { $0.trimmed.len }) < 30 { return false }
        var breaks = 0, soft = 0, strong = 0
        for i in 0..<max(0, lines.count - 1) {
            let a = lines[i].trimmed, b = lines[i + 1].trimmed
            if a.isEmpty || b.isEmpty { continue }
            if ITEM.test(b) { continue }
            breaks += 1
            if SPLIT.test(a) || !END.test(a) { soft += 1 }
            if SPLIT.test(a) || (!END.test(a) && Rx(#"^[a-z(]"#).test(b)) { strong += 1 }
        }
        return breaks > 0 && strong > 0 && soft * 2 >= breaks
    }

    /// `text` as pasted from a PDF, with the layout taken out; text that is not hard-wrapped comes back with pdfChars only.
    public static func pdfText(_ text: String?) -> String {
        let s = pdfChars(text)
        if !s.contains("\n") { return s }
        let lines = s.jsSplit("\n")
        if !hardWrapped(lines) { return s }
        let width = median(lines.map { $0.trimmed }.filter { !$0.isEmpty }.map { $0.len })
        let lead = Rx(#"^\n*"#).match(s)?.str ?? "", trail = Rx(#"\n*$"#).match(s)?.str ?? ""
        var out: [String] = []
        for block in Rx(#"\n[ \t]*\n+"#).split(s.trimmed) {
            let ls = block.jsSplit("\n").map { Rx(#"\s{2,}"#).replace($0.trimmed, with: " ") }.filter { !$0.isEmpty }
            let kept = ls.count > 1 ? ls.filter { !PAGE_NUMBER.test($0) } : ls
            var paras: [String] = []
            var last = ""
            for line in kept {
                let ends = paras.isEmpty || ITEM.test(line) || (END.test(last) && Double(last.len) < Double(width) * 0.8)
                last = line
                if ends { paras.append(line); continue }
                let prev = paras[paras.count - 1]
                // `abil-` + `ities` is one word; `self-` + `Supervised` keeps its hyphen, with no space after it.
                paras[paras.count - 1] = !SPLIT.test(prev) ? "\(prev) \(line)" : Rx(#"^[a-z]"#).test(line) ? prev.slice(0, -1) + line : prev + line
            }
            out.append(paras.joined(separator: "\n"))
        }
        return lead + out.joined(separator: "\n\n") + trail
    }
}

// MARK: doc-find.js, find.js

public enum DocFind {
    public struct Segment: Equatable { public var text: String; public var block: Int; public init(text: String, block: Int) { self.text = text; self.block = block } }
    public struct Spot: Equatable { public var seg: Int; public var offset: Int }
    public struct Match: Equatable { public var start: Spot; public var end: Spot }

    static func folded(_ text: String) -> String { let low = text.lowercased(); return low.len == text.len ? low : text }

    /// The matches of `query` in `segments` (consecutive segments with the same block are one block), in page order. Case
    /// is ignored; a match may run across the segments of one block, never into the next.
    public static func segmentMatches(_ list: [Segment], _ query: String?) -> [Match] {
        let needle = folded(query ?? "")
        if needle.trimmed.isEmpty { return [] }
        var out: [Match] = []
        var i = 0
        while i < list.count {
            var j = i
            var starts: [Int] = []
            var hay = ""
            while j < list.count && list[j].block == list[i].block { starts.append(hay.len); hay += folded(list[j].text); j += 1 }
            func at(_ pos: Int, _ end: Bool) -> Spot? {
                for k in 0..<starts.count {
                    let from = starts[k], to = from + list[i + k].text.len
                    if from == to { continue }
                    if end ? (pos > from && pos <= to) : (pos >= from && pos < to) { return Spot(seg: i + k, offset: pos - from) }
                }
                return nil
            }
            var hit = hay.indexOf(needle)
            while hit >= 0 {
                if let s = at(hit, false), let e = at(hit + needle.len, true) { out.append(Match(start: s, end: e)) }
                hit = hay.indexOf(needle, hit + needle.len)
            }
            i = j
        }
        return out
    }

    /// Which match is in front after a search, and whether to scroll to it (find.js nextFind).
    public static func nextFind(fresh: Bool, step: Int = 0, count: Int, at: Int, fromStart: Bool = false, firstInView: () -> Int = { 0 }) -> (at: Int, scroll: Bool) {
        if count == 0 { return (-1, false) }
        let next: Int
        if fromStart { next = 0 }
        else if fresh || at < 0 { next = step < 0 ? count - 1 : firstInView() }
        else if step != 0 { next = ((at + step) % count + count) % count }
        else { next = min(at, count - 1) }
        return (next, fresh || step != 0 || fromStart)
    }
}

// MARK: doc-sync.js

/// The same document open in several windows (2026-10-03): keeps per document key the newest revision saved or taken,
/// so an announcement from before this window's own save is never taken over it.
public final class DocSync {
    public enum Outcome: String { case ignore, wait, conflict, take }
    private var revisions: [String: Double] = [:]
    private var writing: [String: Int] = [:]
    private var incoming: [String: (text: String, revision: Double)] = [:]
    private let hasEdits: (String) -> Bool
    private let take: (String, String) -> Void
    private let conflict: (String, (text: String, revision: Double)) -> Void

    public init(hasEdits: @escaping (String) -> Bool, take: @escaping (String, String) -> Void, conflict: @escaping (String, (text: String, revision: Double)) -> Void) {
        self.hasEdits = hasEdits; self.take = take; self.conflict = conflict
    }

    public func revision(_ key: String) -> Double { revisions[key] ?? 0 }
    public func seen(_ key: String, _ value: Double?) { if let v = value, v.isFinite, v > revision(key) { revisions[key] = v } }

    /// Another window saved `change`.
    @discardableResult
    public func announced(_ key: String, _ change: (text: String, revision: Double)?) -> Outcome {
        guard let change, change.revision > revision(key) else { return .ignore }
        if (writing[key] ?? 0) > 0 {
            if let held = incoming[key] { if change.revision > held.revision { incoming[key] = change } } else { incoming[key] = change }
            return .wait
        }
        if hasEdits(key) { conflict(key, change); return .conflict }
        seen(key, change.revision)
        take(key, change.text)
        return .take
    }

    public func saving(_ key: String) { writing[key] = (writing[key] ?? 0) + 1 }

    /// A save of this window's answered (`value`: its revision; nil when it failed).
    @discardableResult
    public func saved(_ key: String, _ value: Double?) -> Outcome? {
        seen(key, value)
        let left = (writing[key] ?? 1) - 1
        if left > 0 { writing[key] = left; return nil }
        writing[key] = nil
        guard let change = incoming.removeValue(forKey: key) else { return nil }
        return announced(key, change)
    }
}

// MARK: key-side.js

/// Where ⌘T, ⌘W and ⌘F go (2026-10-16): whichever of the middle canvas ('doc'), the Stage or the terminal was last clicked
/// or given the keyboard. Elements are the app's own views; `sideOf`/`paneOf` say where one is.
public final class SideTracker<Element: AnyObject> {
    public enum Side: String { case doc, stage, terminal }
    private(set) public var side: Side
    private(set) public var pane = 0
    private weak var held: Element?
    private let sideOf: (Element?) -> Side?
    private let paneOf: (Element?) -> Int?
    public init(start: Side = .doc, sideOf: @escaping (Element?) -> Side?, paneOf: @escaping (Element?) -> Int?) { side = start; self.sideOf = sideOf; self.paneOf = paneOf }
    private func take(_ el: Element?) {
        guard let now = sideOf(el) else { return }
        side = now
        if now == .doc, let at = paneOf(el) { pane = at }
    }
    /// A press anywhere in the window.
    public func pressed(_ el: Element?) { held = nil; take(el) }
    /// The window gave up the keyboard; `active` is what had it.
    public func left(_ active: Element?) { held = active }
    /// Something in the window took the keyboard; the same element getting it back is no move.
    public func focused(_ el: Element?) { let back = held; held = nil; if let el, el === back { return }; take(el) }
    /// A page on the Stage took the keyboard.
    public func page() { side = .stage }
}

public enum KeySide {
    /// Whether the middle canvas takes ⌘T, ⌘W and ⌘F.
    public static func docHasKeys(_ side: String, docShown: Bool = true, docFull: Bool = false) -> Bool { docShown && (docFull || side == "doc") }
    public enum Close: Equatable { case pane(Int), tab(String) }
    /// What ⌘W closes in the middle canvas: the pane beside when it was clicked last, else the tab in front (never
    /// Workspace, 'ws', or the only tab left).
    public static func docClose(tabs: [String], active: String?, pane: Int = 0, beside: Int = 0) -> Close? {
        if pane >= 1 && pane <= beside { return .pane(pane) }
        guard let active, !active.isEmpty, active != "ws", tabs.count >= 2, tabs.contains(active) else { return nil }
        return .tab(active)
    }
}

// MARK: drop.js

public enum Drop {
    public enum Item: Equatable { case path(String), bytes(Data, mime: String, name: String?), url(String) }
    static let HTTP = Rx(#"^https?:\/\/"#, "i")
    static let DATA_IMAGE = Rx(#"^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$"#, "i")
    static let MAX_DATA_CHARS = 28 * 1024 * 1024

    static func decodeEntities(_ v: String) -> String {
        var s = Rx(#"&#(\d+);"#).replace(v) { m in Int(m[1]!).flatMap { Unicode.Scalar($0) }.map { String($0) } ?? m.str }
        s = Rx(#"&#x([0-9a-f]+);"#, "i").replace(s) { m in Int(m[1]!, radix: 16).flatMap { Unicode.Scalar($0) }.map { String($0) } ?? m.str }
        let ents = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'"]
        return Rx(#"&(amp|lt|gt|quot|apos);"#).replace(s) { ents[$0[1]!]! }
    }

    /// The src of the first <img> in a drag's html; '' when there is none.
    public static func firstImageSource(_ html: String?) -> String {
        guard let tag = Rx(#"<img\b[^>]*>"#, "i").match(html ?? ""), let src = Rx(#"\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#, "i").match(tag.str) else { return "" }
        return decodeEntities((src[1] ?? src[2] ?? src[3] ?? "").trimmed)
    }

    /// A Google Images result dragged by its link is the picture it leads to; any other link is itself.
    public static func pictureBehind(_ url: String) -> String {
        guard let u = URLComponents(string: url), let host = u.host else { return url }
        if Rx(#"(^|\.)google\.[a-z.]+$"#, "i").test(host) && u.path == "/imgres", let wrapped = u.queryItems?.first(where: { $0.name == "imgurl" })?.value, HTTP.test(wrapped) { return wrapped }
        return url
    }

    static func dataImage(_ value: String?) -> Item? {
        guard let v = value, !v.isEmpty, v.len <= MAX_DATA_CHARS, let m = DATA_IMAGE.match(v) else { return nil }
        guard let data = Data(base64Encoded: Rx(#"\s+"#).replace(m[2]!, with: "")) else { return nil }
        return .bytes(data, mime: m[1]!.lowercased(), name: nil)
    }

    /// What a drop holds: files first and alone (a path when on disk, else its bytes); with none, one link: the first
    /// http(s) line of the uri list, else the first <img>'s src; a data: picture as its bytes.
    public static func readDrop(files: [Item], uriList: String?, html: String?) -> [Item] {
        if !files.isEmpty { return files }
        let lines = (uriList ?? "").components(separatedBy: CharacterSet(charactersIn: "\r\n")).map { $0.trimmed }.filter { !$0.isEmpty && !$0.hasPrefix("#") }
        if let link = lines.first(where: { HTTP.test($0) }) { return [.url(pictureBehind(link))] }
        let src = firstImageSource(html)
        if HTTP.test(src) { return [.url(src)] }
        if let picture = dataImage(lines.first) ?? dataImage(src) { return [picture] }
        return []
    }

    /// A picture the document takes as a pasted one (png, jpeg, gif or webp): bytes of that type, or a path that ends so.
    public static func isPastable(_ item: Item?) -> Bool {
        switch item {
        case .bytes(_, let mime, _)?: return Rx(#"^image\/(png|jpeg|gif|webp)$"#).test(mime)
        case .path(let p)?: return Rx(#"\.(png|jpe?g|gif|webp)$"#, "i").test(p)
        default: return false
        }
    }
}

// MARK: selection-card.cjs

public enum SelectionCard {
    public static let CARD_GAP: Double = 8
    public static let SEL_CARD_W: Double = 340
    public static let CARD_SHADE = (top: 18.0, side: 24.0, bottom: 30.0)

    static func ok(_ r: CGRect?) -> Bool { guard let r else { return false }; return r.origin.x.isFinite && r.origin.y.isFinite && r.size.width.isFinite && r.size.height.isFinite }

    /// Under the selection's last line, left with it, CARD_GAP below; with no room, above its first line; with room
    /// nowhere, as far down as it fits. Inside the pane; nil once the selection is wholly out of it.
    public static func place(line: CGRect?, all: CGRect?, pane: CGRect?, size: CGSize?, gap: Double = CARD_GAP) -> CGRect? {
        guard ok(line), ok(pane), let line, let pane, let size, size.width.isFinite, size.height.isFinite else { return nil }
        let sel = ok(all) ? all! : line
        let right = pane.origin.x + pane.size.width, bottom = pane.origin.y + pane.size.height
        if sel.origin.x + sel.size.width <= pane.origin.x || sel.origin.x >= right || sel.origin.y + sel.size.height <= pane.origin.y || sel.origin.y >= bottom { return nil }
        let width = max(0, min(size.width, pane.size.width)), height = max(0, min(size.height, pane.size.height))
        let x = max(pane.origin.x, min(line.origin.x, right - width))
        let below = line.origin.y + line.size.height + gap, above = min(sel.origin.y, line.origin.y) - gap - height
        let y: Double
        if below >= pane.origin.y && below + height <= bottom { y = below }
        else if above >= pane.origin.y && above + height <= bottom { y = above }
        else { y = max(pane.origin.y, min(below, bottom - height)) }
        return CGRect(x: x.rounded(), y: y.rounded(), width: width.rounded(), height: height.rounded())
    }

    /// A web page's card view (2026-10-18): the card placed in the pane less the shadow's room, the view that room bigger.
    public static func shadedPlace(line: CGRect?, all: CGRect?, pane: CGRect?, size: CGSize?, shade: (top: Double, side: Double, bottom: Double) = CARD_SHADE, gap: Double = CARD_GAP) -> CGRect? {
        guard ok(pane), let pane, let size, let line, size.width.isFinite, size.height.isFinite, place(line: line, all: all, pane: pane, size: size, gap: gap) != nil else { return nil }
        let inner = CGRect(x: pane.origin.x + shade.side, y: pane.origin.y + shade.top, width: max(0, pane.size.width - 2 * shade.side), height: max(0, pane.size.height - shade.top - shade.bottom))
        guard let at = place(line: line, all: all, pane: inner, size: size, gap: gap) else {
            // the selection only in the pane's rim: the card as near it as the pane lets it be
            let x = max(inner.origin.x, min(line.origin.x, inner.origin.x + inner.size.width - size.width))
            let y = max(inner.origin.y, min(line.origin.y + line.size.height + gap, inner.origin.y + inner.size.height - size.height))
            return CGRect(x: (x - shade.side).rounded(), y: (y - shade.top).rounded(), width: (min(size.width, inner.size.width) + 2 * shade.side).rounded(), height: (min(size.height, inner.size.height) + shade.top + shade.bottom).rounded())
        }
        return CGRect(x: (at.origin.x - shade.side).rounded(), y: (at.origin.y - shade.top).rounded(), width: (at.size.width + 2 * shade.side).rounded(), height: (at.size.height + shade.top + shade.bottom).rounded())
    }
}

// MARK: mark-answers.cjs

public enum MarkAnswers {
    public static let WEB = "web"
    static let ATTRIBUTION = Rx(#"^\*([^*]+)\*$"#)
    static let CROP = Rx(#"^crops\/[\w-]{1,64}\.png$"#)

    /// An answer's lines as main sends them → the answer as the document would hold it, and its foot without the stars.
    public static func answerOf(_ lines: [String]) -> (answer: String, foot: String) {
        var body = lines.map { Rx(#"^bart\+?> ?"#).replace($0, with: "", global: false) }
        var foot = ""
        if let last = body.last, let m = ATTRIBUTION.match(last) { foot = m[1]!; body.removeLast() }
        return (body.joined(separator: "\n").trimmed, foot)
    }

    /// A finished answer as a mark keeps it.
    public static func askEntry(id: String, question: String?, lines: [String], provider: String?, name: String?, effort: String?, ms: Double?, at: String, crop: String? = nil) -> JSONValue {
        let a = answerOf(lines)
        var entry: [String: JSONValue] = [
            "id": .string(id), "question": .string((question ?? "").trimmed), "answer": .string(a.answer),
            "meta": .object(["provider": provider.map { .string($0) } ?? .null, "name": name.map { .string($0) } ?? .null, "effort": effort.map { .string($0) } ?? .null,
                             "ms": ms.map { .number($0) } ?? .null, "foot": .string(a.foot)]),
            "at": .string(at), "pos": .null, "collapsed": .bool(false),
        ]
        if let crop, CROP.test(crop) { entry["crop"] = .string(crop) }
        return .object(entry)
    }

    /// The marks with `entry` added to the answers of mark `markId` on `page` (once), or the web page's list (page nil).
    public static func withAsk(_ marks: JSONValue?, page: String?, markId: String, entry: JSONValue) -> JSONValue {
        let key = page ?? WEB
        guard case .object(var all)? = marks, let list = all[key]?.array,
              let at = list.firstIndex(where: { $0["id"]?.string == markId }) else { return marks ?? .object([:]) }
        var m = list[at].object ?? [:]
        var asks = m["asks"]?.array ?? []
        if asks.contains(where: { $0["id"] == entry["id"] }) { return marks! }
        asks.append(entry)
        m["asks"] = .array(asks)
        var newList = list
        newList[at] = .object(m)
        all[key] = .array(newList)
        return .object(all)
    }
}

// MARK: markdown.js (a markdown file read on the Stage)

public enum MarkdownFile {
    public enum Block: Equatable {
        case h(level: Int, text: String)
        case p(String)
        case li(ordered: Bool, marker: String, depth: Int, checked: Bool?, text: String)
        case quote(String)
        case code(lang: String, text: String)
        case hr
    }
    public struct Run: Equatable { public var text: String; public var bold = false; public var italic = false; public var code = false; public var href: String? = nil }

    static let FENCE = Rx(#"^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)"#)
    static let HEADING = Rx(#"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$"#)
    static let ITEM = Rx(#"^(\s*)([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?(.*)$"#)
    static let QUOTE = Rx(#"^\s{0,3}>\s?(.*)$"#)
    static let RULE = Rx(#"^\s{0,3}([-*_])(\s*\1){2,}\s*$"#)
    static let INLINE = Rx(#"(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])"#)

    public static func blocks(_ source: String?) -> [Block] {
        let lines = Rx(#"\r\n?"#).replace(source ?? "", with: "\n").jsSplit("\n")
        var out: [Block] = []
        var para: [String]? = nil
        func endPara() { if let p = para { out.append(.p(p.joined(separator: " "))); para = nil } }
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if let fence = FENCE.match(line) {
                endPara()
                var body: [String] = []
                var j = i + 1
                while j < lines.count && !lines[j].trimmed.hasPrefix(fence[1]!) { body.append(lines[j]); j += 1 }
                out.append(.code(lang: fence[2] ?? "", text: body.joined(separator: "\n")))
                i = j + 1
                continue
            }
            defer { i += 1 }
            if line.trimmed.isEmpty { endPara(); continue }
            if let m = HEADING.match(line) { endPara(); out.append(.h(level: m[1]!.len, text: m[2] ?? "")); continue }
            if RULE.test(line) { endPara(); out.append(.hr); continue }
            if let m = ITEM.match(line) {
                endPara()
                let box: Bool? = m[3].map { Rx("x", "i").test($0) }
                out.append(.li(ordered: Rx(#"\d"#).test(m[2]!), marker: m[2]!, depth: m[1]!.replacingOccurrences(of: "\t", with: "    ").len / 2, checked: box, text: m[4] ?? ""))
                continue
            }
            if let m = QUOTE.match(line) {
                endPara()
                if case .quote(let t)? = out.last { out[out.count - 1] = .quote(t + " " + (m[1] ?? "")) } else { out.append(.quote(m[1] ?? "")) }
                continue
            }
            if para == nil { para = [] }
            para!.append(line.trimmed)
        }
        endPara()
        return out
    }

    /// A line's runs. Nesting beyond one level is read as plain text.
    public static func runs(_ text: String?) -> [Run] {
        let s = text ?? ""
        var out: [Run] = []
        var at = 0
        for m in INLINE.matchAll(s) {
            if m.index > at { out.append(Run(text: s.slice(at, m.index))) }
            if m[1] != nil { out.append(Run(text: m[2] ?? "", code: true)) }
            else if let b = m[3] ?? m[4] { out.append(Run(text: b, bold: true)) }
            else if let it = m[5] ?? m[6] { out.append(Run(text: it, italic: true)) }
            else if let t = m[7] { out.append(Run(text: t, href: m[8])) }
            else { out.append(Run(text: m[9]!, href: m[9])) }
            at = m.end
        }
        if at < s.len { out.append(Run(text: s.slice(at))) }
        return out
    }
}
