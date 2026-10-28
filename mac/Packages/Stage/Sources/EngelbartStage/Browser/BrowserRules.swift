import Foundation
import CoreGraphics
import EngelbartCore

// The rules every Stage page lives by (src/main/browser/views.cjs), pure so they are tested without a web view: which
// addresses a tab may load, how a pdf is recognised, and the shapes a page's script may send (anything else is dropped).

public enum BrowserRules {
    public static let maxPDFBytes = 200 * 1024 * 1024 // the library's limit
    public static let findMax = 1000
    public static let quoteTimeout: TimeInterval = 2
    public static let selectionTimeout: TimeInterval = 0.3 // an @bart turn does not wait on a page that does not answer
    public static let shotTimeout: TimeInterval = 1.5
    public static let shotMaxEdge: CGFloat = 1568 // what the models look at without scaling it down themselves
    public static let maxPageMarks = 2000
    public static let boxTimeout: TimeInterval = 2
    public static let frameTimeout: TimeInterval = 0.15
    public static let loginTimeout: TimeInterval = 5 * 60
    public static let saveTimeout: TimeInterval = 2 * 60
    public static let cardW: CGFloat = 336
    public static let cardMinH: CGFloat = 64
    public static let cardMaxH: CGFloat = 1600
    public static let cardHideWhileScrolling = false
    public static let runLines = 400, runLine = 4000

    // page-preload.cjs constants the main side checks against
    public static let maxExact = 5000
    public static let maxAffix = 64
    public static let pageText = 4000
    public static var maxPageText: Int { 2 * pageText + 2 * maxExact }
    public static let highlightName = "engelbart-web-mark"
    public static let sectionName = "engelbart-web-section"

    /// Never handed to another app: these either reach into this one or are not addresses at all.
    public static let internalSchemes: Set<String> = ["http:", "https:", "file:", "about:", "blob:", "data:", "javascript:", "chrome:", "devtools:", "view-source:", "engelbart:"]

    public enum Refusal: Error, LocalizedError, Equatable {
        case invalid(String)
        public var errorDescription: String? { if case .invalid(let s) = self { return s }; return nil }
    }

    /// http(s) only. 0.0.0.0 is what dev servers print, not an address to visit.
    public static func parseBrowserUrl(_ value: String) throws -> URL {
        guard !value.isEmpty, value.utf16.count <= 8192 else { throw Refusal.invalid("URL must be a bounded string") }
        guard var url = JSURL(value) else { throw Refusal.invalid("URL is invalid") }
        guard url.protocol == "http:" || url.protocol == "https:" else { throw Refusal.invalid("URL protocol must be http or https") }
        if url.hostname == "0.0.0.0" { url.hostname = "localhost" }
        guard let out = URL(string: url.href) else { throw Refusal.invalid("URL is invalid") }
        return out
    }

    /// A file: address inside `root`, links followed. A file that is not there yet is judged by where it would be.
    public static func parseFileUrl(_ value: String, root: String?) throws -> URL {
        guard !value.isEmpty, value.utf16.count <= 8192 else { throw Refusal.invalid("URL must be a bounded string") }
        guard let parsed = JSURL(value), parsed.protocol == "file:", parsed.hostname.isEmpty, let url = URL(string: parsed.href), url.isFileURL else {
            throw Refusal.invalid("URL is invalid")
        }
        guard let root, !root.isEmpty else { throw Refusal.invalid("Files cannot be opened here") }
        let home = realPath(root)
        let resolved = realPath(url.path)
        guard resolved == home || resolved.hasPrefix(home + "/") else { throw Refusal.invalid("Only files inside your home directory can be opened") }
        return url
    }

    /// The real path, links followed; a path that is not there yet is its nearest existing folder's real path and the
    /// rest (Electron's path.resolve kept /var for /private/var there, refusing a new file in a linked folder).
    static func realPath(_ path: String) -> String {
        let standard = (path as NSString).standardizingPath
        if let real = realpath(standard, nil) { defer { free(real) }; return String(cString: real) }
        let parent = (standard as NSString).deletingLastPathComponent
        if parent == standard || parent.isEmpty { return standard }
        return (realPath(parent) as NSString).appendingPathComponent((standard as NSString).lastPathComponent)
    }

    public static func isFileUrl(_ value: String?) -> Bool { SRx("^file:", "i").test(value ?? "") }

    /// Where a page may go: about:blank; http(s) from anywhere; the disk only from a page already on it.
    public static func allowed(_ value: String, from current: String?, root: String?) -> Bool {
        if value == "about:blank" { return true }
        if isFileUrl(value) && !isFileUrl(current) { return false }
        do {
            if isFileUrl(value) { _ = try parseFileUrl(value, root: root) } else { _ = try parseBrowserUrl(value) }
            return true
        } catch { return false }
    }

    /// `slack://…`, `mailto:…`: an address some other app owns ('' for none).
    public static func externalScheme(_ value: String?) -> String {
        guard let url = JSURL(value ?? "") else { return "" }
        return internalSchemes.contains(url.protocol) ? "" : url.protocol
    }

    public static func originOf(_ value: String?) -> String { JSURL(value ?? "")?.origin ?? "" }

    /// This machine only: the one place a self-signed certificate is accepted.
    public static func isLoopback(_ hostname: String?) -> Bool {
        let host = (hostname ?? "").lowercased()
        return host == "localhost" || host.hasSuffix(".localhost") || host == "[::1]" || host == "::1" || SRx(#"^127(\.\d{1,3}){3}$"#).test(host)
    }

    /// Sites sniff "Electron/x" and serve a refusal, so it goes; the app's own token stays (2026-10-12).
    public static func cleanUserAgent(_ userAgent: String?) -> String { SRx(#" Electron\/\S+"#, "i").replace(userAgent ?? "", with: "") }

    /// An address whose path ends in .pdf.
    public static func pdfAddress(_ value: String?) -> Bool {
        guard let url = JSURL(value ?? "") else { return false }
        return SRx(#"\.pdf$"#, "i").test(url.pathname)
    }

    static let pdfType = SRx(#"^\s*application\/(?:x-)?pdf\b"#, "i")
    public static func isPDFType(_ mime: String?) -> Bool { pdfType.test(mime ?? "") }

    /// Whether a response or download is a pdf: by its type, its file name, or an address ending .pdf (a site serving
    /// one as octet-stream).
    public static func isPDF(mime: String?, fileName: String?, url: String?) -> Bool {
        isPDFType(mime) || SRx(#"\.pdf$"#, "i").test(fileName ?? "") || pdfAddress(url)
    }

    /// A pdf answer as a download (Electron rewrote its headers to `attachment; <filename>`): nil for anything else.
    public static func pdfAsDownload(_ headers: [String: String]) -> [String: String]? {
        func header(_ name: String) -> String { headers.first { $0.key.lowercased() == name }?.value ?? "" }
        guard isPDFType(header("content-type")) else { return nil }
        let name = JSStr.trim(SRx(#"^\s*(?:inline|attachment)\b\s*;?\s*"#, "i").replace(header("content-disposition"), with: "", global: false))
        var out = headers.filter { $0.key.lowercased() != "content-disposition" }
        out["Content-Disposition"] = name.isEmpty ? "attachment" : "attachment; \(name)"
        return out
    }

    /// What a pdf's tab is called: its file name without .pdf, else the last part of its address.
    public static func pdfName(_ fileName: String?, _ url: String?) -> String {
        var name = fileName ?? ""
        if name.isEmpty, let u = JSURL(url ?? "") {
            name = JSStr.decodeURIComponent(u.pathname.split(separator: "/").last.map(String.init) ?? "") ?? ""
        }
        let out = SRx(#"\.pdf$"#, "i").replace(name, with: "", global: false)
        return out.isEmpty ? "pdf" : out
    }

    /// Bounds from the placeholder, scaled by the window's zoom (Electron); finite, ≤100000, at least 1×1.
    public static func boundsFrom(_ rect: CGRect, zoom: CGFloat = 1) throws -> CGRect {
        let scale = zoom.isFinite && zoom > 0 ? zoom : 1
        for v in [rect.origin.x, rect.origin.y, rect.width, rect.height] where !v.isFinite || abs(v) > 100000 { throw Refusal.invalid("Bounds must be finite numbers") }
        return CGRect(x: (rect.origin.x * scale).rounded(), y: (rect.origin.y * scale).rounded(),
                      width: max(1, (rect.width * scale).rounded()), height: max(1, (rect.height * scale).rounded()))
    }

    /// Whether ink on the page at `url` is kept: a page on the web or on disk; never a preview or a local server.
    public static func fileablePage(_ url: String?) -> Bool {
        guard let u = JSURL(url ?? "") else { return false }
        if u.protocol == "file:" { return true }
        return (u.protocol == "http:" || u.protocol == "https:") && !StageAddressKey.isPreviewAddress(u.href)
    }

    // ---------------------------------------------------------------------------------- what a page may send

    public struct Quote: Equatable, Sendable {
        public var exact: String, prefix: String, suffix: String
        public init(exact: String, prefix: String = "", suffix: String = "") { self.exact = exact; self.prefix = prefix; self.suffix = suffix }
        public var json: JSONValue { ["exact": .string(exact), "prefix": .string(prefix), "suffix": .string(suffix)] }
    }

    /// { exact, prefix, suffix } of strings within their limits; anything else is nil.
    public static func quoteInput(_ value: JSONValue?) -> Quote? {
        guard case .object(let o)? = value else { return nil }
        guard let exact = o["exact"]?.string else { return nil }
        // `{ prefix = '', suffix = '' }`: missing is '', anything but a string refuses the quote
        if let p = o["prefix"], p.string == nil { return nil }
        if let s = o["suffix"], s.string == nil { return nil }
        let prefix = o["prefix"]?.string ?? "", suffix = o["suffix"]?.string ?? ""
        if JSStr.trim(exact).isEmpty || exact.utf16.count > maxExact || prefix.utf16.count > maxAffix || suffix.utf16.count > maxAffix { return nil }
        return Quote(exact: exact, prefix: prefix, suffix: suffix)
    }

    public struct Selection: Equatable, Sendable { public var quote: Quote; public var pageText: String }

    /// A live selection: { quote, pageText (at most maxPageText) }, or nil.
    public static func selectionInput(_ value: JSONValue?) -> Selection? {
        guard case .object(let o)? = value, let quote = quoteInput(o["quote"]) else { return nil }
        return Selection(quote: quote, pageText: JSStr.slice(o["pageText"]?.string ?? "", 0, maxPageText))
    }

    static func finite(_ v: JSONValue?, _ limit: Double = 1e6) -> Double? {
        guard let n = v?.double, n.isFinite, abs(n) <= limit else { return nil }
        return n
    }

    public struct Rect: Equatable, Sendable {
        public var x: Double, y: Double, w: Double, h: Double
        public init(x: Double, y: Double, w: Double, h: Double) { self.x = x; self.y = y; self.w = w; self.h = h }
        public var json: JSONValue { ["x": .number(x), "y": .number(y), "w": .number(w), "h": .number(h)] }
    }
    public struct Viewport: Equatable, Sendable { public var width: Double, height: Double }

    static func rect(_ v: JSONValue?) -> Rect? {
        guard let x = finite(v?["x"]), let y = finite(v?["y"]), let w = finite(v?["w"]), let h = finite(v?["h"]), w >= 0, h >= 0 else { return nil }
        return Rect(x: x, y: y, w: w, h: h)
    }

    public struct SelectionCardOffer: Equatable, Sendable {
        public var token: String?
        public var line: Rect?
        public var rect: Rect?
        public var viewport: Viewport?
        public var quote: Quote?
        public var markId: String?
        public var pageText = ""
    }

    /// A selection's card as a page says it: { token: null } (taken back), or a token with where it is, the quote when newly
    /// offered, or a markId for a highlight's own card; nil for anything else.
    public static func selectionCardInput(_ value: JSONValue?) -> SelectionCardOffer? {
        guard case .object(let o)? = value else { return nil }
        if o["token"] == .null { return SelectionCardOffer(token: nil) }
        guard let token = o["token"]?.string, SRx(#"^[\w-]{1,32}$"#).test(token) else { return nil }
        guard let w = finite(o["viewport"]?["width"]), let h = finite(o["viewport"]?["height"]) else { return nil }
        var out = SelectionCardOffer(token: token, line: rect(o["line"]), rect: rect(o["rect"]), viewport: Viewport(width: w, height: h))
        if let mark = o["markId"] {
            guard let id = mark.string, !id.isEmpty, id.utf16.count <= 64 else { return nil }
            out.markId = id
            out.pageText = JSStr.slice(o["pageText"]?.string ?? "", 0, maxPageText)
            return out
        }
        guard let q = o["quote"] else { return out }
        guard let quote = quoteInput(q) else { return nil }
        out.quote = quote
        out.pageText = JSStr.slice(o["pageText"]?.string ?? "", 0, maxPageText)
        return out
    }

    /// Whether a web highlight has a note or an answer (2026-10-18): its symbol shows.
    public static func isNoted(_ m: JSONValue?) -> Bool {
        guard let m else { return false }
        if let note = m["note"]?.string, !JSStr.trim(note).isEmpty { return true }
        return (m["asks"]?.array ?? []).contains { a in a["deleted"]?.bool != true && !JSStr.trim(a["answer"]?.string ?? "").isEmpty }
    }

    /// A page's web marks as its script is given them: [{ id, quote, noted? }] or [{ id, box }], only the well-formed.
    public static func marksForPage(_ list: [JSONValue]) -> [JSONValue] {
        var out: [JSONValue] = []
        for m in list {
            if out.count >= maxPageMarks { break }
            guard let id = m["id"]?.string, id.utf16.count <= 64 else { continue }
            if Boxes.isBox(m) { if let box = Boxes.boxInput(m["box"]) { out.append(["id": .string(id), "box": box]) }; continue }
            guard let q = m["quote"], q.object != nil else { continue }
            let quote = quoteInput(["exact": q["exact"] ?? .null, "prefix": .string(JSStr.slice(q["prefix"]?.string ?? "", -maxAffix)), "suffix": .string(JSStr.slice(q["suffix"]?.string ?? "", 0, maxAffix))])
            guard let quote else { continue }
            out.append(isNoted(m) ? ["id": .string(id), "quote": quote.json, "noted": true] : ["id": .string(id), "quote": quote.json])
        }
        return out
    }

    public struct BoxReply: Equatable, Sendable { public var box: JSONValue; public var text: String }

    /// What a page says of a box drawn on it: { box, text (≤ TEXT_MAX) }, or nil.
    public static func boxReplyInput(_ value: JSONValue?) -> BoxReply? {
        guard case .object(let o)? = value, let box = Boxes.boxInput(o["box"]) else { return nil }
        let text = JSStr.slice(JSStr.trim(SRx(#"\s+"#).replace(o["text"]?.string ?? "", with: " ")), 0, Boxes.textMax)
        return BoxReply(box: box, text: text)
    }

    public struct BoxReport: Equatable, Sendable {
        public struct Item: Equatable, Sendable { public var id: String; public var x, y, w, h: Double }
        public struct Note: Equatable, Sendable { public var id: String; public var x, y, size: Double }
        public struct Resizing: Equatable, Sendable { public var id: String; public var x, y: Double; public var viewport: Viewport }
        public var rects: [Item]
        public var selected: String?
        public var size: Viewport?
        public var resizing: Resizing?
        public var notes: [Note] = []
    }

    /// Where a page says its boxes are, only the well-formed; nil for anything else.
    public static func boxReportInput(_ value: JSONValue?) -> BoxReport? {
        guard let list = value?["rects"]?.array else { return nil }
        let rects: [BoxReport.Item] = list.prefix(Boxes.maxBoxes).compactMap { r in
            guard let id = r["id"]?.string, id.utf16.count <= 64, let x = finite(r["x"]), let y = finite(r["y"]), let w = finite(r["w"]), let h = finite(r["h"]), w > 0, h > 0 else { return nil }
            return BoxReport.Item(id: id, x: x, y: y, w: w, h: h)
        }
        let selected = value?["selected"]?.string.flatMap { $0.utf16.count <= 64 ? $0 : nil }
        var size: Viewport?
        if let w = finite(value?["size"]?["width"]), let h = finite(value?["size"]?["height"]) { size = Viewport(width: w, height: h) }
        var resizing: BoxReport.Resizing?
        if let z = value?["resizing"], let id = z["id"]?.string, rects.contains(where: { $0.id == id }), let x = finite(z["x"]), let y = finite(z["y"]),
           let vw = finite(z["viewport"]?["width"]), let vh = finite(z["viewport"]?["height"]) {
            resizing = BoxReport.Resizing(id: id, x: x, y: y, viewport: Viewport(width: vw, height: vh))
        }
        let notes: [BoxReport.Note] = (value?["notes"]?.array ?? []).prefix(Boxes.maxNotes).compactMap { c in
            guard let id = c["id"]?.string, id.utf16.count <= 64, let x = finite(c["x"]), let y = finite(c["y"]), let s = finite(c["size"]), s > 0, s <= 64 else { return nil }
            return BoxReport.Note(id: id, x: x, y: y, size: s)
        }
        return BoxReport(rects: rects, selected: selected, size: size, resizing: resizing, notes: notes)
    }

    public struct BoxView: Equatable, Sendable { public var id: String?; public var rect: Rect?; public var viewport: Viewport?; public var scrolling = false }

    /// Where a page says its selected box is in its viewport, or { id: nil }.
    public static func boxViewInput(_ value: JSONValue?) -> BoxView {
        guard let id = value?["id"]?.string, id.utf16.count <= 64, let r = rect(value?["rect"]), r.w > 0, r.h > 0,
              let w = finite(value?["viewport"]?["width"]), let h = finite(value?["viewport"]?["height"]) else { return BoxView(id: nil) }
        return BoxView(id: id, rect: r, viewport: Viewport(width: w, height: h), scrolling: value?["scrolling"]?.bool == true)
    }

    public struct BoxResize: Equatable, Sendable { public var id: String; public var rect: Rect; public var box: JSONValue; public var text: String }

    /// A box resized as its page says it, or nil.
    public static func boxResizeInput(_ value: JSONValue?) -> BoxResize? {
        guard let id = value?["id"]?.string, SRx(#"^[\w-]{1,64}$"#).test(id) else { return nil }
        guard let x = finite(value?["rect"]?["x"], 1e5), let y = finite(value?["rect"]?["y"], 1e5), let w = finite(value?["rect"]?["w"], 1e5), let h = finite(value?["rect"]?["h"], 1e5), w > 0, h > 0 else { return nil }
        guard let got = boxReplyInput(value) else { return nil }
        return BoxResize(id: id, rect: Rect(x: x, y: y, w: w, h: h), box: got.box, text: got.text)
    }

    /// What the Stage has running from boxes' cards, as the card is given it; only the well-formed, within bounds.
    public static func boxAsksInput(_ list: [JSONValue]) -> [JSONValue] {
        func text(_ v: JSONValue?, _ max: Int) -> String { JSStr.slice(v?.string ?? "", 0, max) }
        return list.prefix(200).compactMap { p in
            guard let askId = p["askId"]?.string, askId.utf16.count <= 64, let markId = p["markId"]?.string, markId.utf16.count <= 64 else { return nil }
            let lines = (p["lines"]?.array ?? []).suffix(runLines).map { JSONValue.string(text($0, runLine)) }
            let log = (p["log"]?.array ?? []).suffix(60).map { JSONValue.string(text($0, 300)) }
            let error: JSONValue = (p["error"] == nil || p["error"] == .null) ? .null : .string(JSStr.slice(p["error"]?.string ?? (p["error"].map { $0.text() } ?? ""), 0, 2000))
            return ["askId": .string(askId), "markId": .string(markId), "question": .string(text(p["question"], 8000)), "activity": .string(text(p["activity"], 300)),
                    "name": .string(text(p["name"], 60)), "effort": .string(text(p["effort"], 30)), "movedUp": .bool(p["movedUp"]?.bool == true),
                    "lines": .array(Array(lines)), "log": .array(Array(log)), "error": error]
        }
    }

    /// A mark's answers as its card shows them, the deleted ones left out (the last 100).
    public static func cardAsks(_ asks: [JSONValue]) -> [JSONValue] {
        asks.filter { $0.object != nil && $0["deleted"]?.bool != true }.suffix(100).map { a in
            let meta: JSONValue = a["meta"]?.object != nil ? ["name": a["meta"]?["name"] ?? .null, "effort": a["meta"]?["effort"] ?? .null] : .null
            return ["id": .string(a["id"]?.string ?? ""), "question": .string(a["question"]?.string ?? ""), "answer": .string(a["answer"]?.string ?? ""), "at": a["at"] ?? .null, "meta": meta]
        }
    }

    /// What a note asks Bart: the words after a leading @bart, or nil for a note that asks nothing.
    public static func bartQuestion(_ note: String?) -> String? {
        guard let m = SRx(#"^\s*@bart(?=\s|$)([\s\S]*)$"#, "i").match(note ?? "") else { return nil }
        let q = JSStr.trim(m[1] ?? "")
        return q.isEmpty ? nil : q
    }

    /// Whether two quotes are the same passage, as the page is given them (marksForPage's affixes).
    public static func sameQuote(_ a: Quote?, _ b: Quote?) -> Bool {
        guard let a, let b, a.exact == b.exact else { return false }
        return JSStr.slice(a.prefix, -maxAffix) == JSStr.slice(b.prefix, -maxAffix) && JSStr.slice(a.suffix, 0, maxAffix) == JSStr.slice(b.suffix, 0, maxAffix)
    }

    // A web highlight (2026-10-18, David's picture): a soft yellow with a thin yellow line under each of its lines.
    public static let markLook = "background-color:rgba(255,214,0,.22);text-decoration-line:underline;text-decoration-style:solid;text-decoration-color:rgba(240,190,0,.9);text-decoration-thickness:2px;text-underline-offset:3px"
    /// The tints' rule (Electron's MARK_CSS), !important so a page's own rule for the name wins only with its own.
    public static var markCSS: String {
        "::highlight(\(highlightName)){\(markLook.components(separatedBy: ";").map { "\($0) !important" }.joined(separator: ";"))}::highlight(\(sectionName)){background-color:rgba(255,196,0,.13) !important}"
    }
    /// The find matches' rule: Chromium's own colours (yellow, the one in front orange), as findInPage drew them.
    public static let findCSS = "::highlight(engelbart-find){background-color:#ffff00 !important;color:#000 !important}::highlight(engelbart-find-on){background-color:#ff9632 !important;color:#000 !important}"
}
