import AppKit
import EngelbartDoc
import EngelbartUI

// An answer as its card draws it (PaperView answerParas/answerHtml, card-look.js ANSWER_FONT): a paragraph a line, with
// what Bart was told a card may hold (bold, italic, code, links, library mentions), a list's mark as "• " and a heading's
// taken off (bold); Chat's citations as numbered circles, a run of three or more folded into its first and "…", and the
// sources under the answer (src/renderer/model/cite.js). Tokens, citations and sources are EngelbartDoc's (Inline, Cite):
// one definition. Links carry engelbart-* addresses the card's text view hands to the host: never the app's window.

enum PaperLink {
    static let lib = "engelbart-lib", file = "engelbart-file", web = "engelbart-href", more = "engelbart-citemore"
    static func libURL(_ id: String) -> URL { URL(string: "\(lib):\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id)")! }
    static func fileURL(_ folder: String, _ rel: String, _ name: String) -> URL {
        var c = URLComponents(); c.scheme = file; c.path = "x"
        c.queryItems = [URLQueryItem(name: "f", value: folder), URLQueryItem(name: "r", value: rel), URLQueryItem(name: "n", value: name)]
        return c.url!
    }
    static func hrefURL(_ href: String) -> URL {
        var c = URLComponents(); c.scheme = web; c.path = "x"; c.queryItems = [URLQueryItem(name: "h", value: href)]
        return c.url!
    }
    static func moreURL(_ run: Int) -> URL { URL(string: "\(more):\(run)")! }
    enum Target { case lib(String), file(folder: String, rel: String, name: String), href(String), more(Int) }
    static func target(_ any: Any) -> Target? {
        let url: URL? = (any as? URL) ?? (any as? String).flatMap(URL.init(string:))
        guard let url, let scheme = url.scheme else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func q(_ k: String) -> String { items.first { $0.name == k }?.value ?? "" }
        switch scheme {
        case lib: return .lib(String(url.absoluteString.dropFirst(lib.count + 1)).removingPercentEncoding ?? "")
        case file: return .file(folder: q("f"), rel: q("r"), name: q("n"))
        case web: return .href(q("h"))
        case more: return .more(Int(url.absoluteString.dropFirst(more.count + 1)) ?? 0)
        default: return .href(url.absoluteString)
        }
    }
}

/// A citation circle's card (cite.js citationCard), carried on the circle's characters for the hover card.
final class CiteCardInfo: NSObject {
    let card: Cite.Card
    init(_ card: Cite.Card) { self.card = card }
}

extension NSAttributedString.Key {
    /// Marks the "Sources" heading: the answer view draws its 1px #eaeaea rule above it.
    static let sourcesRule = NSAttributedString.Key("engelbart.sourcesRule")
    /// A citation circle's card (CiteCardInfo).
    static let citeCard = NSAttributedString.Key("engelbart.citeCard")
}

enum AnswerFormat {
    static let ink = NSColor(hex: "#171717")
    static let grey = NSColor(hex: "#8f8f8f")
    static let blue = NSColor(hex: "#0070f3")
    static let dotted = NSColor(hex: "#c9c9c9")
    /// 15px/1.55 sans (card-look.js ANSWER_FONT).
    static func base(_ size: CGFloat = 15, line: CGFloat = 1.55, color: NSColor = ink) -> [NSAttributedString.Key: Any] {
        let p = NSMutableParagraphStyle()
        p.minimumLineHeight = (size * line).rounded(); p.maximumLineHeight = (size * line).rounded()
        p.paragraphSpacing = 6 // `p { margin: 0 0 6px }`
        return [.font: Fonts.sans(size), .foregroundColor: color, .paragraphStyle: p]
    }

    struct Names {
        var lib: (String) -> String?? = { _ in nil }
        var source: (String) -> String? = { _ in nil }
        var fileState: (String, String) -> PaperFileState? = { _, _ in nil }
    }

    /// A citation's circle (CIRCLE: min 16 wide, 16 high, radius 8, margin 0 1px 0 2px; NUMBER 500 10px #4d4d4d;
    /// #ebebeb; a counter's white with #c9c9c9; the "…" of a folded run #f2f2f2 / #eaeaea with #8f8f8f).
    static func circle(_ n: String, counter: Bool = false, more: Bool = false) -> NSImage {
        let font = Fonts.sans(10, weight: 500)
        let tw = (n as NSString).size(withAttributes: [.font: font]).width
        let w = max(16, ceil(tw) + 8), size = NSSize(width: w + 3, height: 16)
        return NSImage(size: size, flipped: false) { _ in
            let r = NSRect(x: 2, y: 0, width: w, height: 16)
            let path = NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), xRadius: 7.5, yRadius: 7.5)
            let fill = more ? NSColor(hex: "#f2f2f2") : counter ? NSColor.white : NSColor(hex: "#ebebeb")
            let edge = more ? NSColor(hex: "#eaeaea") : counter ? NSColor(hex: "#c9c9c9") : NSColor(hex: "#ebebeb")
            fill.setFill(); path.fill()
            edge.setStroke(); path.lineWidth = 1; path.stroke()
            let p = NSMutableParagraphStyle(); p.alignment = .center
            (n as NSString).draw(in: NSRect(x: 2, y: 1, width: w, height: 13), withAttributes: [.font: font, .foregroundColor: more ? grey : NSColor(hex: "#4d4d4d"), .paragraphStyle: p])
            return true
        }
    }

    static func circleString(_ n: String, counter: Bool = false, more: Bool = false, link: URL, card: Cite.Card?, tip: String?) -> NSAttributedString {
        let att = NSTextAttachment()
        att.image = circle(n, counter: counter, more: more)
        att.bounds = CGRect(x: 0, y: -2, width: att.image!.size.width, height: 16)
        let s = NSMutableAttributedString(attachment: att)
        var attrs: [NSAttributedString.Key: Any] = [.link: link]
        if let card { attrs[.citeCard] = CiteCardInfo(card) }
        if let tip { attrs[.toolTip] = tip }
        s.addAttributes(attrs, range: NSRange(location: 0, length: s.length))
        return s
    }

    static let LEAD = try! NSRegularExpression(pattern: #"\s*[:–—]\s*$"#)
    static let LEAD_TOKEN = try! NSRegularExpression(pattern: #"^(?:\*|`|\[|@\[|!\[|\$)"#)
    static func test(_ re: NSRegularExpression, _ s: String) -> Bool { re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil }

    /// One line's inside: its inline tokens drawn (doc.js inlineHtml, the parts an answer holds). `expanded`: folded runs
    /// opened (a click or the pointer on their "…").
    static func inline(_ text: String, base attrs: [NSAttributedString.Key: Any], cites: [String: Int], names: Names, expanded: Bool = false) -> NSMutableAttributedString {
        var parts = Inline.tokens(text)
        let out = NSMutableAttributedString()
        let size = (attrs[.font] as? NSFont)?.pointSize ?? 15
        var runs: [CiteRunRole?] = Array(repeating: nil, count: parts.count)
        if parts.contains(where: { Cite.citationOf($0) != nil }) {
            // A colon or dash right before a citation is left out where the circle is drawn (2026-10-22, David).
            for k in 0..<max(0, parts.count - 1) where Cite.citationOf(parts[k + 1]) != nil && Cite.citationOf(parts[k]) == nil && !test(LEAD_TOKEN, parts[k]) {
                parts[k] = LEAD.stringByReplacingMatches(in: parts[k], range: NSRange(location: 0, length: (parts[k] as NSString).length), withTemplate: " ")
            }
            runs = Cite.citationRuns(parts)
        }
        for (k, p) in parts.enumerated() {
            if p.isEmpty { continue }
            if let r = runs[k], r.role == .rest, !expanded { continue }
            out.append(token(p, attrs, size: size, cites: cites, names: names))
            if let r = runs[k], r.role == .first, !expanded {
                out.append(circleString("…", more: true, link: PaperLink.moreURL(r.run), card: nil, tip: "\(r.more) more"))
            }
        }
        return out
    }

    static func token(_ p: String, _ attrs: [NSAttributedString.Key: Any], size: CGFloat, cites: [String: Int], names: Names) -> NSAttributedString {
        if p == "\\$" { return NSAttributedString(string: "$", attributes: attrs) }
        if p.hasPrefix("**"), p.hasSuffix("**"), p.count > 4 {
            var a = attrs; a[.font] = Fonts.sans(size, weight: 600)
            return inline(String(p.dropFirst(2).dropLast(2)), base: a, cites: cites, names: names)
        }
        if p.hasPrefix("`"), p.hasSuffix("`"), p.count > 2 {
            var a = attrs; a[.font] = Fonts.mono(size * 0.92); a[.backgroundColor] = NSColor(hex: "#f2f2f2")
            return NSAttributedString(string: String(p.dropFirst().dropLast()), attributes: a)
        }
        if p.hasPrefix("*"), p.hasSuffix("*"), p.count > 2 {
            var a = attrs; a[.font] = NSFontManager.shared.convert((attrs[.font] as? NSFont) ?? Fonts.sans(size), toHaveTrait: .italicFontMask)
            return NSAttributedString(string: String(p.dropFirst().dropLast()), attributes: a)
        }
        if p.range(of: "^@(?:bart|chat|brainstorm|orient|discover|create)$", options: [.regularExpression, .caseInsensitive]) != nil {
            var a = attrs; a[.foregroundColor] = blue; a[.font] = Fonts.sans(size, weight: 500)
            return NSAttributedString(string: p, attributes: a)
        }
        if let f = NoteText.fileMentionOf(p) { return fileChip(f, base: attrs, names: names) }
        if let l = NoteText.libMentionOf(p) { return libChip(l, base: attrs, names: names) }
        if let c = Cite.citationOf(p) {
            let n = cites[Cite.citationPassage(c)] ?? 1
            let source = Cite.citationSource(c, names.source)
            return circleString(String(n), counter: c.counter, link: PaperLink.hrefURL(c.href), card: Cite.citationCard(c, source: source), tip: nil)
        }
        if let lm = try? NSRegularExpression(pattern: #"^\[([^\]]+)\]\(([^)]+)\)$"#).firstMatch(in: p, range: NSRange(location: 0, length: (p as NSString).length)) {
            return link((p as NSString).substring(with: lm.range(at: 1)), (p as NSString).substring(with: lm.range(at: 2)), attrs)
        }
        if p.range(of: #"^https?://\S+$"#, options: .regularExpression) != nil { return link(p, p, attrs) }
        return NSAttributedString(string: p, attributes: attrs)
    }

    static func link(_ label: String, _ href: String, _ attrs: [NSAttributedString.Key: Any]) -> NSAttributedString {
        var a = attrs
        a[.link] = PaperLink.hrefURL(href); a[.foregroundColor] = blue; a[.underlineStyle] = NSUnderlineStyle.single.rawValue
        return NSAttributedString(string: label, attributes: a)
    }

    /// A library mention's chip (doc.js libHtml): blue 500 with a dotted underline; its name now; grey when gone.
    static func libChip(_ l: NoteText.LibMention, base attrs: [NSAttributedString.Key: Any], names: Names) -> NSAttributedString {
        var a = attrs
        let now = names.lib(l.id)
        if case .some(.none) = now {
            a[.foregroundColor] = grey; a[.toolTip] = "No longer in the library"
            return NSAttributedString(string: "@\(l.name)", attributes: a)
        }
        let shown: String
        if case .some(.some(let n)) = now, !n.isEmpty { shown = n } else { shown = l.name }
        a[.foregroundColor] = blue
        a[.underlineStyle] = NSUnderlineStyle.single.rawValue | NSUnderlineStyle.patternDot.rawValue
        a[.underlineColor] = dotted
        a[.link] = PaperLink.libURL(l.id)
        return NSAttributedString(string: "@\(shown)", attributes: a)
    }

    /// A file mention's chip (doc.js fileHtml): folder / path on hover; grey and struck through when gone.
    static func fileChip(_ f: NoteText.FileMention, base attrs: [NSAttributedString.Key: Any], names: Names) -> NSAttributedString {
        var a = attrs
        let folder = names.lib(f.folderId)
        if case .some(.none) = folder {
            a[.foregroundColor] = grey; a[.toolTip] = "Its folder is no longer in the library"
            return NSAttributedString(string: "@\(f.name)", attributes: a)
        }
        var folderName = "folder"
        if case .some(.some(let n)) = folder, !n.isEmpty { folderName = n }
        let gone = names.fileState(f.folderId, f.rel) == .missing
        let where_ = "\(folderName) / \(f.rel)"
        a[.toolTip] = gone ? "Not found: \(where_)" : where_
        a[.foregroundColor] = gone ? grey : blue
        a[.underlineStyle] = NSUnderlineStyle.single.rawValue | NSUnderlineStyle.patternDot.rawValue
        a[.underlineColor] = gone ? NSColor(hex: "#d9d9d9") : dotted
        if gone { a[.strikethroughStyle] = NSUnderlineStyle.single.rawValue; a[.strikethroughColor] = dotted }
        a[.link] = PaperLink.fileURL(f.folderId, f.rel, f.name)
        return NSAttributedString(string: "@\(f.name)", attributes: a)
    }

    /// The answer: paragraphs, then its sources (a rule above them, as cite.js draws it).
    static func answer(_ text: String, names: Names, color: NSColor = ink, expanded: Bool = false) -> NSAttributedString {
        let attrs = base(color: color)
        let cites = Cite.citationNumbers([text])
        let out = NSMutableAttributedString()
        let lines = text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        for (i, line) in lines.enumerated() {
            let inside: NSMutableAttributedString
            if let r = line.range(of: "^[-*] ", options: .regularExpression) {
                inside = NSMutableAttributedString(string: "• ", attributes: attrs)
                inside.append(inline(String(line[r.upperBound...]), base: attrs, cites: cites, names: names, expanded: expanded))
            } else if let r = line.range(of: "^#{1,6} ", options: .regularExpression) {
                var a = attrs; a[.font] = Fonts.sans(15, weight: 700)
                inside = inline(String(line[r.upperBound...]), base: a, cites: cites, names: names, expanded: expanded)
            } else { inside = inline(line, base: attrs, cites: cites, names: names, expanded: expanded) }
            out.append(inside)
            if i < lines.count - 1 { out.append(NSAttributedString(string: "\n", attributes: attrs)) }
        }
        let sources = Cite.citationSources(text, cites: cites, citeSource: names.source)
        if !sources.isEmpty {
            let head = NSMutableParagraphStyle(); head.paragraphSpacingBefore = 16; head.paragraphSpacing = 4
            out.append(NSAttributedString(string: "\n", attributes: attrs))
            out.append(NSAttributedString(string: "Sources\n", attributes: [.font: Fonts.sans(11, weight: 500), .foregroundColor: grey, .kern: 0.2, .paragraphStyle: head, .sourcesRule: true]))
            let row = NSMutableParagraphStyle(); row.minimumLineHeight = 20; row.maximumLineHeight = 20; row.lineBreakMode = .byTruncatingTail
            for (k, s) in sources.enumerated() {
                let line = NSMutableAttributedString()
                for p in s.passages {
                    let card = Cite.citationCard(label: p.label, cite: p.cite, find: p.find, note: p.note, source: s.name, counter: p.counter)
                    line.append(circleString(String(p.n), counter: p.counter, link: PaperLink.hrefURL(p.href), card: card, tip: nil))
                }
                line.append(NSAttributedString(string: " \(s.name)", attributes: [.font: Fonts.sans(12), .foregroundColor: NSColor(hex: "#4d4d4d"), .link: PaperLink.hrefURL(s.href), .toolTip: s.name]))
                if k < sources.count - 1 { line.append(NSAttributedString(string: "\n")) }
                line.addAttribute(.paragraphStyle, value: row, range: NSRange(location: 0, length: line.length))
                out.append(line)
            }
        }
        return out
    }

    /// A streamed answer's paragraphs, its citations and a link still being written left out (cite.js streamingText).
    static func streaming(_ text: String) -> String { Cite.streamingText(text) }
}
