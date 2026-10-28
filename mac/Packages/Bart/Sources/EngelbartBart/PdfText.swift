import Foundation
import EngelbartDoc
import PDFKit

// context/pdf-text.cjs — text out of a PDF, for the catalog. A paper that prints an "Abstract" section already carries
// the blurb its authors wrote, so that text becomes the summary and no model runs; only a PDF without one is summarized
// like a note, from its extracted text.
//
// pdf.js → PDFKit. pdf.js gave text items with a transform; lines were rebuilt by baseline and rotated items (the arXiv
// stamp down the margin) dropped. PDFKit gives each printed line as a selection (selectionsByLine): its bounds give the
// line's x, its baseline y (PDF space, up from the bottom, as pdf.js's) and its height (the font's size as the line's
// box; heights are compared with each other only, so the scale does not matter); a line whose box is much taller than
// wide and holds more than a few characters is rotated text and is collected apart.

public struct PdfLine: Equatable, Sendable {
    public var page: Int
    public var x: Double, y: Double, h: Double
    public var text: String
    public init(page: Int, x: Double, y: Double, h: Double, text: String) { self.page = page; self.x = x; self.y = y; self.h = h; self.text = text }
}

public enum PdfText {
    public static let maxAbstractChars = 4000
    static let headingAlone = JSRegex("^abstract\\s*[:.]?$", "i")
    static let headingRunIn = JSRegex("^abstract\\s*[—–:.-]\\s*(\\S.*)$", "i")
    static let nextSection = JSRegex("^(?:(?:\\d+(?:\\.\\d+)*\\.?|[IVX]{1,4}\\.)\\s+[A-Z]|introduction\\b|ccs concepts\\b|keywords?\\b|key words\\b|index terms\\b|author keywords\\b|additional key ?words\\b|categories and subject descriptors\\b|general terms\\b|acm reference format\\b|permission to make\\b)", "i")
    static let endsSentence = JSRegex("[.!?][\"'”’)\\]]?$")

    public struct Unreadable: Error, LocalizedError { public var errorDescription: String? { "The pdf could not be read" } }

    public static func open(_ file: String) throws -> PDFDocument {
        guard let doc = PDFDocument(url: URL(fileURLWithPath: file)) else { throw Unreadable() }
        return doc
    }

    /// The lines of page `n` (1-based). Rotated lines are never part of the text; a caller that wants them (the arXiv
    /// stamp) passes `rotated` to collect them in.
    public static func pageLines(_ doc: PDFDocument, _ n: Int, rotated: ((String) -> Void)? = nil) -> [PdfLine] {
        guard let page = doc.page(at: n - 1), let all = page.selection(for: page.bounds(for: .mediaBox)) else { return [] }
        var lines: [PdfLine] = []
        for sel in all.selectionsByLine() {
            let raw = sel.string ?? ""
            let text = raw.squashedSpaces
            if text.isEmpty { continue }
            let b = sel.bounds(for: page)
            if b.height > b.width * 2 && text.jsLength > 3 { rotated?(raw); continue } // rotated: watermarks, margin stamps
            lines.append(PdfLine(page: n, x: Double(b.minX).rounded(), y: Double(b.minY).rounded(), h: (Double(b.height) * 10).rounded() / 10, text: text))
        }
        return lines
    }

    /// Lines of the first `maxPages` pages, in reading order.
    public static func readLines(_ file: String, maxPages: Int = 3) throws -> [PdfLine] {
        let doc = try open(file)
        var lines: [PdfLine] = []
        for n in stride(from: 1, through: min(maxPages, doc.pageCount), by: 1) { lines += pageLines(doc, n) }
        return lines
    }

    static func joinLines(_ parts: [String]) -> String {
        parts.reduce("") { text, part in
            if text.isEmpty { return part }
            // "prin-" + "ciples": a word broken across lines loses its hyphen.
            if JSRegex("[A-Za-z]-$").test(text) && JSRegex("^[a-z]").test(part) { return String(text.dropLast()) + part }
            return "\(text) \(part)"
        }
    }

    /// The text under an "Abstract" section header, or nil when the lines have none.
    public static func findAbstract(_ lines: [PdfLine]) -> String? {
        guard let at = lines.firstIndex(where: { headingAlone.test($0.text) || headingRunIn.test($0.text) }) else { return nil }
        let heading = lines[at]
        let runIn = headingRunIn.match(heading.text)
        var parts: [String] = runIn.map { [$0[1] ?? ""] } ?? []
        var bodyHeight: Double? = runIn != nil ? heading.h : nil
        var previous = heading
        for line in lines.dropFirst(at + 1) {
            if bodyHeight == nil { bodyHeight = line.h }
            // PDF space runs upward, as pdf.js's: a line above the last one starts a new block (a new column).
            let newBlock = line.page != previous.page || line.y > previous.y + 2 || abs(line.x - previous.x) > 40
            if nextSection.test(line.text) { break }
            if runIn == nil, let bh = bodyHeight, heading.h > bh + 0.5, line.h >= heading.h - 0.2, line.text.jsLength < 60 { break }
            if !parts.isEmpty, newBlock, endsSentence.test(parts.last!) { break }
            if line.h > 0, let bh = bodyHeight, bh > 0, line.h < bh - 1.5 { continue } // running heads, footnote marks
            parts.append(line.text)
            previous = line
            if parts.joined(separator: " ").jsLength > maxAbstractChars { break }
        }
        var text = joinLines(parts).jsTrim
        if text.isEmpty { return nil }
        if text.jsLength > maxAbstractChars {
            let head = text.jsSlice(0, maxAbstractChars)
            let stop = [". ", "? ", "! "].map { (head as NSString).range(of: $0, options: .backwards).location }.filter { $0 != NSNotFound }.max() ?? -1
            text = stop > 0 ? head.jsSlice(0, stop + 1) : head
        }
        return text
    }

    /// The abstract of a PDF (looked for on its first three pages), or nil.
    public static func extractAbstract(_ file: String) throws -> String? { findAbstract(try readLines(file, maxPages: 3)) }

    /// The whole text of a PDF, one line per printed line (for the model, when there is no abstract).
    public static func extractText(_ file: String, maxPages: Int = 120) throws -> String {
        try readLines(file, maxPages: maxPages).map { $0.text }.joined(separator: "\n")
    }
}

// context/pdf-kind.cjs — is this pdf a paper? `paper` is a tag, inferred from what the file prints and says about itself
// (Caragea et al. 2016: structure beats bag-of-words). A paper is the arXiv stamp, or any two of: a DOI (in its metadata
// or on page 1), an Abstract heading (first three pages), a Keywords / Index Terms / CCS Concepts heading, a line that is
// only References / Bibliography / Works Cited (up to page 60). Tuned to say no when unsure.
public enum PdfKind {
    static let firstPages = 3
    static let maxPages = 60
    static let maxBytes = 200 * 1024 * 1024
    static let arxivStamp = JSRegex("arXiv:\\s*(?:\\d{4}\\.\\d{4,5}|[a-z-]+(?:\\.[A-Z]{2})?/\\d{7})(?:v\\d+)?\\s*\\[[A-Za-z0-9_.-]+\\]\\s*\\d{1,2}\\s+[A-Z][a-z]{2}\\s+\\d{4}")
    static let doi = JSRegex("\\b10\\.\\d{4,9}/[^\\s\"<>]{2,}")
    static let keywords = JSRegex("^(?:keywords?|key words|index terms|author keywords|additional key ?words(?: and phrases)?|ccs concepts)\\s*(?:[:—–•.-]|$)", "i")
    static let references = JSRegex("^(?:\\d+\\.?\\s+|[IVX]+\\.\\s+)?(?:references|bibliography|works cited|literature cited|references and notes)\\s*$", "i")

    public struct Signals: Equatable, Sendable { public var arxiv, doi, abstract, keywords: Bool; public var references: Bool? }

    public struct TooLarge: Error, LocalizedError { public var errorDescription: String? { "The pdf is too large to look into" } }

    static func checkSize(_ file: String) throws {
        let size = (try FileManager.default.attributesOfItem(atPath: file)[.size] as? Int) ?? 0
        if size > maxBytes { throw TooLarge() }
    }

    /// What the file says about itself: the document attributes (Info dictionary), as one text.
    static func aboutText(_ doc: PDFDocument) -> String {
        (doc.documentAttributes ?? [:]).map { "\($0.key)=\($0.value)" }.sorted().joined(separator: " ")
    }

    public static func signals(_ file: String) throws -> Signals {
        try checkSize(file)
        let doc = try PdfText.open(file)
        var lines: [PdfLine] = []
        var stamps: [String] = []
        for n in stride(from: 1, through: min(firstPages, doc.pageCount), by: 1) {
            lines += PdfText.pageLines(doc, n, rotated: n == 1 ? { stamps.append($0) } : nil)
        }
        let pageOne = lines.filter { $0.page == 1 }.map { $0.text }
        var s = Signals(arxiv: arxivStamp.test(stamps.joined(separator: " ")) || pageOne.contains { arxivStamp.test($0) },
                        doi: doi.test(aboutText(doc)) || pageOne.contains { doi.test($0) },
                        abstract: PdfText.findAbstract(lines) != nil,
                        keywords: lines.contains { keywords.test($0.text) }, references: nil)
        let others = [s.doi, s.abstract, s.keywords].filter { $0 }.count
        if s.arxiv || others != 1 { return s } // decided either way without the reference list
        var found = lines.contains { references.test($0.text) }
        var n = firstPages + 1
        while !found && n <= min(maxPages, doc.pageCount) { found = PdfText.pageLines(doc, n).contains { references.test($0.text) }; n += 1 }
        s.references = found
        return s
    }

    public static func isPaper(_ s: Signals) -> Bool { s.arxiv || [s.doi, s.abstract, s.keywords, s.references == true].filter { $0 }.count >= 2 }

    /// The tags a pdf's content earns: ['paper'] or []. Throws when the file cannot be read as a pdf.
    public static func inspect(_ file: String) throws -> [String] { isPaper(try signals(file)) ? ["paper"] : [] }

    static let noTitle = JSRegex("^(?:untitled|title|document|unknown|none|slide ?\\d*|microsoft (?:word|powerpoint) - .*|.*\\.(?:docx?|pptx?|pdf|tex|dvi|ps|indd|rtf|odt|pages|key|txt|md|html?|eps|png|jpe?g|svg|tiff?|ai))$", "i")
    static let templateTitle = JSRegex("\\b(?:formatting instructions|instructions for (?:authors|\\w+ proceedings)|author(?:s'?)? (?:guidelines|kit)|submission (?:template|format)|preparation of papers|paper title|your (?:paper )?title|insert (?:your )?title|template|style ?(?:file|guide)|sample (?:paper|document)|latex class|class file|acmart)\\b", "i")
    static let notAName = JSRegex("^(?:pii|doi|issn|isbn|arxiv)\\b|^https?:|\\b(?:journals|elsevier|springer|sciencedirect|ieee xplore|aaas)\\b|^\\S+$", "i")

    /// A metadata Title as a name: '' when it says nothing, is its template's, or is an identifier.
    public static func usableTitle(_ value: String?) -> String {
        let text = (value ?? "").squashedSpaces
        guard text.jsLength >= 3, text.jsLength <= 300, JSRegex("\\p{L}{2}").test(text), !noTitle.test(text), !templateTitle.test(text), !notAName.test(text) else { return "" }
        return text
    }

    /// What a pdf calls itself (its metadata Title), '' when it has none worth a name.
    public static func title(_ file: String) throws -> String {
        try checkSize(file)
        let doc = try PdfText.open(file)
        return usableTitle(doc.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String)
    }
}
