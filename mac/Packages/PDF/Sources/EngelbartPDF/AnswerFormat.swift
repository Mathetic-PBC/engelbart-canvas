import AppKit
import EngelbartUI

// An answer as its card draws it (PaperView answerParas/answerHtml, card-look.js ANSWER_FONT): a paragraph a line, with
// what Bart was told a card may hold (bold, italic, code, links, library mentions), a list's mark as "• " and a heading's
// taken off (bold); Chat's citations as numbered circles and the sources under the answer (src/renderer/model/cite.js).
// Links carry engelbart-* addresses the card's text view hands to the host: never the app's window.

enum PaperLink {
    static let lib = "engelbart-lib", file = "engelbart-file", web = "engelbart-href"
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
    enum Target { case lib(String), file(folder: String, rel: String, name: String), href(String) }
    static func target(_ any: Any) -> Target? {
        let url: URL? = (any as? URL) ?? (any as? String).flatMap(URL.init(string:))
        guard let url, let scheme = url.scheme else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func q(_ k: String) -> String { items.first { $0.name == k }?.value ?? "" }
        switch scheme {
        case lib: return .lib(String(url.absoluteString.dropFirst(lib.count + 1)).removingPercentEncoding ?? "")
        case file: return .file(folder: q("f"), rel: q("r"), name: q("n"))
        case web: return .href(q("h"))
        default: return .href(url.absoluteString)
        }
    }
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

    // INLINE (doc.js), the parts an answer holds.
    static let inlineRe = try! NSRegularExpression(pattern: #"(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|@\[[^\]\n]+\]\(lib:[\w-]+(?::[\w.~%/-]+)?\)|\[[^\]\n]+\]\([^)\s]+\)|@(?:[Bb]art|[Cc]hat|[Bb]rainstorm|[Oo]rient|[Dd]iscover|[Cc]reate)(?=\s|$)|https?://[^\s<>]*[^\s<>.,;:!?)\]'"*`])"#)

    struct Citation { var label: String; var href: String; var key: String; var find: String; var note: String; var cite: String; var counter: Bool }

    /// A citation from a `[label](href)` token: a link whose fragment has `cite=` of a known kind (cite.js citationOf,
    /// passage-link.cjs splitTarget, the common cases).
    static func citation(_ tok: String) -> Citation? {
        guard let m = try? NSRegularExpression(pattern: #"^\[([^\]]+)\]\(([^)]+)\)$"#).firstMatch(in: tok, range: NSRange(location: 0, length: (tok as NSString).length)) else { return nil }
        let ns = tok as NSString, label = ns.substring(with: m.range(at: 1)), href = ns.substring(with: m.range(at: 2))
        guard let hash = href.firstIndex(of: "#") else { return nil }
        let fragment = String(href[href.index(after: hash)...]), address = String(href[..<hash])
        guard fragment.range(of: "(?:^|&)cite=", options: .regularExpression) != nil else { return nil }
        var keys: [String: String] = [:]
        var find = ""
        var rest = fragment
        // trailing `&key=value` pairs (cite, counter, to, note, page), then `find=` is the rest
        while let r = rest.range(of: "&(cite|counter|to|note|page)=([^&]*)$", options: .regularExpression) {
            let pair = String(rest[r].dropFirst()), eq = pair.firstIndex(of: "=")!
            keys[String(pair[..<eq])] = String(pair[pair.index(after: eq)...])
            rest = String(rest[..<r.lowerBound])
        }
        if rest.hasPrefix("find=") { find = String(rest.dropFirst(5)) } else if rest.hasPrefix("cite=") { keys["cite"] = String(rest.dropFirst(5)) }
        func words(_ s: String?) -> String { (s ?? "").replacingOccurrences(of: "+", with: " ").removingPercentEncoding?.trimmingCharacters(in: .whitespacesAndNewlines) ?? (s ?? "") }
        let cite = words(keys["cite"]).lowercased()
        guard ["you", "other", "source"].contains(cite) else { return nil }
        var key = address
        if address.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil {
            key = address.lowercased().replacingOccurrences(of: "^https?://(www\\.)?", with: "", options: .regularExpression).replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        }
        return Citation(label: label, href: href, key: key, find: words(find), note: words(keys["note"]), cite: cite, counter: words(keys["counter"]) == "1")
    }

    static func passageKey(_ c: Citation) -> String { "\(c.key)\n\(c.find)\(c.note.isEmpty ? "" : "\n\(c.note)")" }

    /// Each distinct passage its number, in the order the answer first cites it.
    static func citationNumbers(_ text: String) -> [String: Int] {
        var out: [String: Int] = [:]
        let re = try! NSRegularExpression(pattern: #"\[([^\]\n]+)\]\(([^)\s]+)\)"#)
        for m in re.matches(in: text, range: NSRange(location: 0, length: (text as NSString).length)) {
            if let c = citation((text as NSString).substring(with: m.range)), out[passageKey(c)] == nil { out[passageKey(c)] = out.count + 1 }
        }
        return out
    }

    static func sourceName(_ c: Citation, name: (String) -> String?) -> String {
        let address = String(c.href.split(separator: "#", maxSplits: 1).first ?? "")
        if let n = name(address) { return n }
        let parts = address.split(separator: "/").map(String.init)
        if parts.last == "workspace.md", parts.count > 1 { return parts[parts.count - 2] }
        if address.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil, let host = URL(string: address)?.host { return host.replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression) }
        return parts.last ?? address
    }

    /// A citation's circle: its number on a grey pill (CIRCLE: 16px high, radius 8, 500 10px #4d4d4d; a counter's white
    /// with a #c9c9c9 edge).
    static func circle(_ n: String, counter: Bool) -> NSImage {
        let font = Fonts.sans(10, weight: 500)
        let tw = (n as NSString).size(withAttributes: [.font: font]).width
        let w = max(16, ceil(tw) + 8), size = NSSize(width: w + 3, height: 16)
        return NSImage(size: size, flipped: false) { _ in
            let r = NSRect(x: 2, y: 0, width: w, height: 16)
            let path = NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), xRadius: 7.5, yRadius: 7.5)
            (counter ? NSColor.white : NSColor(hex: "#ebebeb")).setFill(); path.fill()
            (counter ? NSColor(hex: "#c9c9c9") : NSColor(hex: "#ebebeb")).setStroke(); path.lineWidth = 1; path.stroke()
            let p = NSMutableParagraphStyle(); p.alignment = .center
            (n as NSString).draw(in: NSRect(x: 2, y: 1, width: w, height: 13), withAttributes: [.font: font, .foregroundColor: NSColor(hex: "#4d4d4d"), .paragraphStyle: p])
            return true
        }
    }

    struct Names {
        var lib: (String) -> String?? = { _ in nil }
        var source: (String) -> String? = { _ in nil }
        var fileState: (String, String) -> PaperFileState? = { _, _ in nil }
    }

    /// One line's inside: its inline tokens drawn.
    static func inline(_ text: String, base attrs: [NSAttributedString.Key: Any], cites: [String: Int], names: Names) -> NSMutableAttributedString {
        let out = NSMutableAttributedString()
        let ns = text as NSString
        var at = 0
        let size = (attrs[.font] as? NSFont)?.pointSize ?? 15
        func plain(_ s: String) { out.append(NSAttributedString(string: s, attributes: attrs)) }
        for m in inlineRe.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if m.range.location > at { plain(ns.substring(with: NSRange(location: at, length: m.range.location - at))) }
            at = m.range.location + m.range.length
            let p = ns.substring(with: m.range)
            if p.hasPrefix("**"), p.hasSuffix("**"), p.count > 4 {
                var a = attrs; a[.font] = Fonts.sans(size, weight: 600)
                out.append(inline(String(p.dropFirst(2).dropLast(2)), base: a, cites: cites, names: names))
            } else if p.hasPrefix("`"), p.hasSuffix("`"), p.count > 2 {
                var a = attrs; a[.font] = Fonts.mono(size * 0.92); a[.backgroundColor] = NSColor(hex: "#f2f2f2")
                out.append(NSAttributedString(string: String(p.dropFirst().dropLast()), attributes: a))
            } else if p.hasPrefix("*"), p.hasSuffix("*"), p.count > 2, !p.hasPrefix("**") {
                var a = attrs; a[.font] = NSFontManager.shared.convert((attrs[.font] as? NSFont) ?? Fonts.sans(size), toHaveTrait: .italicFontMask)
                out.append(NSAttributedString(string: String(p.dropFirst().dropLast()), attributes: a))
            } else if p.range(of: "^@(?:bart|chat|brainstorm|orient|discover|create)$", options: [.regularExpression, .caseInsensitive]) != nil {
                var a = attrs; a[.foregroundColor] = blue; a[.font] = Fonts.sans(size, weight: 500)
                out.append(NSAttributedString(string: p, attributes: a))
            } else if let f = NoteText.fileMentionOf(p) {
                out.append(fileChip(f, base: attrs, names: names))
            } else if let l = NoteText.libMentionOf(p) {
                out.append(libChip(l, base: attrs, names: names))
            } else if let c = citation(p) {
                let n = cites[passageKey(c)] ?? 1
                let att = NSTextAttachment(); att.image = circle(String(n), counter: c.counter)
                att.bounds = CGRect(x: 0, y: -2, width: att.image!.size.width, height: 16)
                let s = NSMutableAttributedString(attachment: att)
                s.addAttributes([.link: PaperLink.hrefURL(c.href), .toolTip: "\(c.label)\n\(c.note.isEmpty ? (c.find.isEmpty ? "The whole source" : "“\(c.find)”") : "Your note: “\(c.note)”")\n\(sourceName(c, name: names.source))"], range: NSRange(location: 0, length: s.length))
                out.append(s)
            } else if let lm = try? NSRegularExpression(pattern: #"^\[([^\]]+)\]\(([^)]+)\)$"#).firstMatch(in: p, range: NSRange(location: 0, length: (p as NSString).length)) {
                let label = (p as NSString).substring(with: lm.range(at: 1)), href = (p as NSString).substring(with: lm.range(at: 2))
                out.append(link(label, href, attrs))
            } else if p.hasPrefix("http") {
                out.append(link(p, p, attrs))
            } else { plain(p) }
        }
        if at < ns.length { plain(ns.substring(from: at)) }
        return out
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
        a[.font] = Fonts.sans(((attrs[.font] as? NSFont)?.pointSize ?? 15), weight: 500).withSize((attrs[.font] as? NSFont)?.pointSize ?? 15)
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
        let state = names.fileState(f.folderId, f.rel)
        let gone = state == .missing
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
    static func answer(_ text: String, names: Names, color: NSColor = ink) -> NSAttributedString {
        let attrs = base(color: color)
        let cites = citationNumbers(text)
        let out = NSMutableAttributedString()
        let lines = text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        for (i, line) in lines.enumerated() {
            var inside: NSMutableAttributedString
            if let r = line.range(of: "^[-*] ", options: .regularExpression) {
                inside = NSMutableAttributedString(string: "• ", attributes: attrs)
                inside.append(inline(String(line[r.upperBound...]), base: attrs, cites: cites, names: names))
            } else if let r = line.range(of: "^#{1,6} ", options: .regularExpression) {
                var a = attrs; a[.font] = Fonts.sans(15, weight: 700)
                inside = inline(String(line[r.upperBound...]), base: a, cites: cites, names: names)
            } else { inside = inline(line, base: attrs, cites: cites, names: names) }
            out.append(inside)
            if i < lines.count - 1 { out.append(NSAttributedString(string: "\n", attributes: attrs)) }
        }
        // Sources: each by its number and what it is
        var seen: [(key: String, n: Int, name: String, href: String, passages: [(Int, Citation)])] = []
        let re = try! NSRegularExpression(pattern: #"\[([^\]\n]+)\]\(([^)\s]+)\)"#)
        for m in re.matches(in: text, range: NSRange(location: 0, length: (text as NSString).length)) {
            guard let c = citation((text as NSString).substring(with: m.range)) else { continue }
            let n = cites[passageKey(c)] ?? cites.count + 1
            if let i = seen.firstIndex(where: { $0.key == c.key }) {
                if !seen[i].passages.contains(where: { $0.0 == n }) { seen[i].passages.append((n, c)) }
            } else { seen.append((c.key, n, sourceName(c, name: names.source), c.href, [(n, c)])) }
        }
        if !seen.isEmpty {
            let head = NSMutableParagraphStyle(); head.paragraphSpacingBefore = 8; head.paragraphSpacing = 4
            out.append(NSAttributedString(string: "\n", attributes: attrs))
            out.append(NSAttributedString(string: "Sources\n", attributes: [.font: Fonts.sans(11, weight: 500), .foregroundColor: grey, .kern: 0.2, .paragraphStyle: head, .sourcesRule: true]))
            let row = NSMutableParagraphStyle(); row.minimumLineHeight = 20; row.maximumLineHeight = 20; row.lineBreakMode = .byTruncatingTail
            for (k, s) in seen.sorted(by: { $0.n < $1.n }).enumerated() {
                let line = NSMutableAttributedString()
                for (n, c) in s.passages {
                    let att = NSTextAttachment(); att.image = circle(String(n), counter: c.counter)
                    att.bounds = CGRect(x: 0, y: -3, width: att.image!.size.width, height: 16)
                    let a = NSMutableAttributedString(attachment: att)
                    a.addAttribute(.link, value: PaperLink.hrefURL(c.href), range: NSRange(location: 0, length: a.length))
                    line.append(a)
                }
                line.append(NSAttributedString(string: " \(s.name)", attributes: [.font: Fonts.sans(12), .foregroundColor: NSColor(hex: "#4d4d4d"), .link: PaperLink.hrefURL(s.href)]))
                if k < seen.count - 1 { line.append(NSAttributedString(string: "\n")) }
                line.addAttribute(.paragraphStyle, value: row, range: NSRange(location: 0, length: line.length))
                out.append(line)
            }
        }
        return out
    }

    /// A streamed answer's paragraphs, its citations and a link still being written left out (cite.js streamingText).
    static func streaming(_ text: String) -> String {
        text.replacingOccurrences(of: #"[ \t]?\[[^\]\n]*\]\((?:(?!\]\()[^\n])*?[#&]cite=[A-Za-z]*(?:&(?:to|counter)=[^&)\n]*)*\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[ \t]?\[[^\]\n]*(?:\]\([^)\n]*)?$"#, with: "", options: .regularExpression)
    }
}

extension NSAttributedString.Key {
    /// Marks the "Sources" heading: the answer view draws its 1px #eaeaea rule above it.
    static let sourcesRule = NSAttributedString.Key("engelbart.sourcesRule")
}
