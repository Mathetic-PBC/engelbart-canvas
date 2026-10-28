import AppKit
import PDFKit

// What pdf.js did off the main thread, done with PDFKit: drawing pages (PaperView drawPage/drawThumb, a canvas a page)
// and reading their text (readText: getTextContent, kept for find and for a note's room). Each queue has its own
// PDFDocument made from the same bytes: a PDFDocument is not to be shared across threads, and the main thread keeps one
// of its own for selections and character geometry, asked only where the person acts (the text layer's laziness,
// eea4073: a 144-page scan's text is never laid out page by page on the main thread).

/// A page's geometry: its displayed size in points (crop box, rotation applied: pdf.js's viewport at scale 1) and the
/// map from PDF page space to it.
public struct PageGeometry: Equatable {
    public var width: Double
    public var height: Double
    /// Page space → display space (origin bottom-left, y up), as PDFKit draws the page.
    public var transform: CGAffineTransform

    public init(page: PDFPage) {
        let t = page.transform(for: .cropBox)
        let b = page.bounds(for: .cropBox).applying(t)
        width = Double(max(1, b.width)); height = Double(max(1, b.height))
        transform = t.concatenating(CGAffineTransform(translationX: -b.minX, y: -b.minY))
    }

    public init(width: Double, height: Double) { self.width = width; self.height = height; transform = .identity }

    /// A rect in page space → page units (fractions of the displayed width, y down from the top).
    public func units(_ r: CGRect) -> PRect {
        let d = r.applying(transform)
        return PRect(Double(d.minX) / width, (height - Double(d.maxY)) / width, Double(d.width) / width, Double(d.height) / width)
    }

    /// A point in page units → page space.
    public func pagePoint(_ u: CGPoint) -> CGPoint {
        CGPoint(x: u.x * width, y: height - u.y * width).applying(transform.inverted())
    }
}

/// A page's text as read in the background.
public struct PageText {
    /// The page's text as PDFKit gives it (offsets are PDFKit's character indices).
    public var string: String
    /// Its lines' boxes in page units (upright ones only), for the text's column and a note's room (textBoxes).
    public var lines: [(box: PRect, chars: Int)]
    /// The text with its line breaks as \n and where each character came from (made off the main thread).
    var normalized: (text: String, map: [Int]) = ("", [0])
}

extension PageText {
    /// Line breaks as \n (PDFKit may give \r\n or \r), with where each character came from.
    static func normalize(_ s: String) -> (text: String, map: [Int]) {
        let u = Array(s.utf16)
        if !u.contains(0x0D) { return (s, Array(0...u.count)) }
        var out: [UInt16] = [], map: [Int] = []
        var i = 0
        while i < u.count {
            if u[i] == 0x0D { out.append(0x0A); map.append(i); i += (i + 1 < u.count && u[i + 1] == 0x0A) ? 2 : 1; continue }
            out.append(u[i]); map.append(i); i += 1
        }
        map.append(u.count)
        return (String(utf16CodeUnits: out, count: out.count), map)
    }
}

/// Reads every page's text, nearest the view first, a page at a time.
final class TextReader {
    private let queue = DispatchQueue(label: "engelbart.pdf.text", qos: .utility)
    private let doc: PDFDocument?
    private var order: [Int] = []
    private var done = Set<Int>()
    private var running = false
    private let lock = NSLock()
    private var cancelled = false
    var onPage: ((Int, PageText) -> Void)?

    init(data: Data) { doc = PDFDocument(data: data) }

    func cancel() { lock.lock(); cancelled = true; order = []; lock.unlock() }

    /// The pages still to read, in this order (called again as the view moves).
    func want(_ pages: [Int]) {
        lock.lock()
        order = pages.filter { !done.contains($0) }
        let start = !running && !order.isEmpty && !cancelled
        if start { running = true }
        lock.unlock()
        if start { queue.async { [weak self] in self?.pump() } }
    }

    private func next() -> Int? {
        lock.lock(); defer { lock.unlock() }
        if cancelled || order.isEmpty { running = false; return nil }
        let n = order.removeFirst()
        done.insert(n)
        return n
    }

    private func pump() {
        while let n = next() {
            guard let page = doc?.page(at: n - 1) else { continue }
            let text = autoreleasepool { TextReader.read(page) }
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.isCancelled else { return }
                self.onPage?(n, text)
            }
        }
    }

    private var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }

    static func read(_ page: PDFPage) -> PageText {
        let s = page.string ?? ""
        let g = PageGeometry(page: page)
        var lines: [(PRect, Int)] = []
        let n = (s as NSString).length
        if n > 0, let sel = page.selection(for: NSRange(location: 0, length: n)) {
            for line in sel.selectionsByLine() {
                let b = line.bounds(for: page)
                guard b.width > 0, b.height > 0 else { continue }
                let u = g.units(b)
                // Upright text only: a stamp up the margin is no part of a column (PaperView textBoxes).
                if u.h > u.w * 1.5 && u.w < 0.05 { continue }
                let chars = (line.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).count
                if chars == 0 { continue }
                lines.append((u, chars))
            }
        }
        var t = PageText(string: s, lines: lines)
        t.normalized = PageText.normalize(s)
        return t
    }
}

/// Draws pages into images on its own queue (pdf.js page.render), one at a time, the latest wish first.
final class PageRenderer {
    private let queue = DispatchQueue(label: "engelbart.pdf.render", qos: .userInitiated)
    private let doc: PDFDocument?
    private let lock = NSLock()
    private var cancelled = Set<Int>() // request tokens stopped before they began
    private var token = 0

    init(data: Data) { doc = PDFDocument(data: data) }

    /// Page n drawn `pixelWidth` px wide → the image on the main queue (nil when it failed or was stopped).
    @discardableResult
    func render(page n: Int, pixelWidth: Int, done: @escaping (CGImage?) -> Void) -> Int {
        lock.lock(); token += 1; let t = token; lock.unlock()
        queue.async { [weak self] in
            guard let self else { return }
            self.lock.lock(); let stop = self.cancelled.remove(t) != nil; self.lock.unlock()
            let image = stop ? nil : autoreleasepool { () -> CGImage? in
                guard let page = self.doc?.page(at: n - 1) else { return nil }
                return PageRenderer.draw(page, pixelWidth: pixelWidth)
            }
            DispatchQueue.main.async { done(image) }
        }
        return t
    }

    /// A request not begun yet is not drawn (a page that went far from the view: drawSoon's stop).
    func cancel(_ t: Int) { lock.lock(); cancelled.insert(t); lock.unlock() }

    static func draw(_ page: PDFPage, pixelWidth: Int) -> CGImage? {
        let g = PageGeometry(page: page)
        let w = max(1, pixelWidth), h = max(1, Int((Double(w) * g.height / g.width).rounded(.down)))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        let s = CGFloat(Double(w) / g.width)
        ctx.scaleBy(x: s, y: s)
        ctx.interpolationQuality = .high
        page.draw(with: .cropBox, to: ctx)
        return ctx.makeImage()
    }
}

/// Character geometry on the main thread's document, for selections, clicks and find (pdf.js's text layer, made only
/// where it is needed).
final class PageChars {
    let doc: PDFDocument
    init(doc: PDFDocument) { self.doc = doc }

    func page(_ n: Int) -> PDFPage? { n >= 1 && n <= doc.pageCount ? doc.page(at: n - 1) : nil }

    /// The boxes of characters `range` on page n in page units, whitespace left out (PaperView textRects: a lone space's
    /// sliver past a line's end drew a thin line), runs on one baseline joined.
    func rects(page n: Int, range: NSRange, geometry g: PageGeometry) -> [PRect] {
        guard let page = page(n), let s = page.string as NSString?, range.length > 0 else { return [] }
        var out: [PRect] = []
        var run: CGRect?
        let end = min(s.length, range.location + range.length)
        var i = max(0, range.location)
        while i < end {
            let c = s.character(at: i)
            if let scalar = Unicode.Scalar(c), scalar.properties.isWhitespace {
                i += 1; continue
            }
            let b = page.characterBounds(at: i)
            if b.width > 0 || b.height > 0 {
                if let r = run, abs(r.minY - b.minY) < 0.5, abs(r.height - b.height) < 0.5, b.minX >= r.minX, b.minX - r.maxX < b.height * 0.6 {
                    run = r.union(b)
                } else {
                    if let r = run { out.append(g.units(r)) }
                    run = b
                }
            }
            i += 1
        }
        if let r = run { out.append(g.units(r)) }
        return out
    }

    /// Whether a point (page units) is on printed words (a pdf.js span).
    func onText(page n: Int, at u: CGPoint, geometry g: PageGeometry) -> Bool {
        guard let page = page(n) else { return false }
        let p = g.pagePoint(u)
        let i = page.characterIndex(at: p)
        // PDFKit can answer the nearest character for a point beside the text: on it only when its box holds the point
        return i >= 0 && page.characterBounds(at: i).insetBy(dx: -1, dy: -1).contains(p)
    }
}
