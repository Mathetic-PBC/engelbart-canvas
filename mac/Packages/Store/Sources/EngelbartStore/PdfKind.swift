import Foundation
import PDFKit
import EngelbartCore

/// Is this pdf a paper? (context/pdf-kind.cjs) Its type says only that it is a pdf; `paper` is a tag inferred from what
/// the file prints and says about itself — structural signals, as CiteSeerX's crawler sorts papers (Caragea et al. 2016):
///
///   arxiv       the stamp arXiv prints down the margin of page 1: id, [category], date
///   doi         a DOI in the file's own metadata, or printed on page 1
///   abstract    an "Abstract" heading on the first three pages
///   keywords    a Keywords / Index Terms / CCS Concepts heading on the first three pages
///   references  a line that is only References / Bibliography / Works Cited, up to page 60
///
/// A paper is the stamp, or any two of the other four. Tuned to say no when unsure. Electron read the text with pdf.js;
/// here PDFKit gives each page's text, one printed line per line.
public enum PdfKind {
    static let firstPages = 3
    static let maxPages = 60
    static let maxBytes = 200 * 1024 * 1024
    static let arxivStamp = #"arXiv:\s*(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?\s*\[[\w.-]+\]\s*\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}"#
    static let doi = #"\b10\.\d{4,9}/[^\s"<>]{2,}"#
    static let keywords = #"^(?:keywords?|key words|index terms|author keywords|additional key ?words(?: and phrases)?|ccs concepts)\s*(?:[:—–•.-]|$)"#
    static let references = #"^(?:\d+\.?\s+|[IVX]+\.\s+)?(?:references|bibliography|works cited|literature cited|references and notes)\s*$"#
    // pdf-text.cjs findAbstract's headings and stops
    static let headingAlone = #"^abstract\s*[:.]?$"#
    static let headingRunIn = #"^abstract\s*[—–:.-]\s*(\S.*)$"#
    static let nextSection = #"^(?:(?:\d+(?:\.\d+)*\.?|[IVX]{1,4}\.)\s+[A-Z]|introduction\b|ccs concepts\b|keywords?\b|key words\b|index terms\b|author keywords\b|additional key ?words\b|categories and subject descriptors\b|general terms\b|acm reference format\b|permission to make\b)"#

    public struct Signals: Equatable, Sendable {
        public var arxiv: Bool, doi: Bool, abstract: Bool, keywords: Bool
        /// nil when nothing turned on it, so the later pages were not read.
        public var references: Bool?
        public init(arxiv: Bool = false, doi: Bool = false, abstract: Bool = false, keywords: Bool = false, references: Bool? = nil) {
            self.arxiv = arxiv; self.doi = doi; self.abstract = abstract; self.keywords = keywords; self.references = references
        }
    }

    static func open(_ file: String) throws -> PDFDocument {
        guard let size = Paths.stat(file)?.size else { throw StoreError("Nothing is at that path") }
        if size > maxBytes { throw StoreError("The pdf is too large to look into") }
        guard let doc = PDFDocument(url: URL(fileURLWithPath: file)), doc.pageCount > 0 else { throw StoreError("The file cannot be read as a pdf") }
        return doc
    }

    /// One page's printed lines, trimmed, empty ones left out.
    static func pageLines(_ doc: PDFDocument, _ n: Int) -> [String] {
        guard let page = doc.page(at: n - 1), let text = page.string else { return [] }
        return text.components(separatedBy: .newlines).map { $0.collapsingWhitespace() }.filter { !$0.isEmpty }
    }

    /// What the file says about itself: its Info dictionary as one text.
    static func aboutText(_ doc: PDFDocument) -> String {
        (doc.documentAttributes ?? [:]).map { "\($0.key): \($0.value)" }.joined(separator: "\n")
    }

    /// pdf-text.cjs findAbstract, on lines without geometry: an "Abstract" heading (alone or run in) followed by text
    /// before the next section.
    static func hasAbstract(_ lines: [String]) -> Bool {
        guard let at = lines.firstIndex(where: { RX.test($0, headingAlone, ci: true) || RX.test($0, headingRunIn, ci: true) }) else { return false }
        if let runIn = RX.match(lines[at], headingRunIn, ci: true), let first = runIn[1], !first.isEmpty { return true }
        for line in lines[(at + 1)...] {
            if RX.test(line, nextSection, ci: true) { break }
            if !line.isEmpty { return true }
        }
        return false
    }

    public static func paperSignals(_ file: String) throws -> Signals {
        let doc = try open(file)
        var lines: [String] = []
        for n in 1...min(firstPages, doc.pageCount) { lines.append(contentsOf: pageLines(doc, n)) }
        let pageOne = pageLines(doc, 1)
        var signals = Signals(
            arxiv: pageOne.contains { RX.test($0, arxivStamp) } || RX.test(pageOne.joined(separator: " "), arxivStamp),
            doi: RX.test(aboutText(doc), doi) || pageOne.contains { RX.test($0, doi) },
            abstract: hasAbstract(lines),
            keywords: lines.contains { RX.test($0, keywords, ci: true) })
        let others = [signals.doi, signals.abstract, signals.keywords].filter { $0 }.count
        if signals.arxiv || others != 1 { return signals } // decided either way without the reference list
        var found = lines.contains { RX.test($0, references, ci: true) }
        var n = firstPages + 1
        while !found && n <= min(maxPages, doc.pageCount) { found = pageLines(doc, n).contains { RX.test($0, references, ci: true) }; n += 1 }
        signals.references = found
        return signals
    }

    public static func isPaper(_ s: Signals) -> Bool {
        s.arxiv || [s.doi, s.abstract, s.keywords, s.references == true].filter { $0 }.count >= 2
    }

    /// The tags a pdf's content earns: ["paper"] or []. Throws when the file cannot be read as a pdf.
    public static func inspectPdf(_ file: String) throws -> [String] { isPaper(try paperSignals(file)) ? ["paper"] : [] }

    // A Title that only names the file it was made from, or says nothing.
    static let noTitle = #"^(?:untitled|title|document|unknown|none|slide ?\d*|microsoft (?:word|powerpoint) - .*|.*\.(?:docx?|pptx?|pdf|tex|dvi|ps|indd|rtf|odt|pages|key|txt|md|html?|eps|png|jpe?g|svg|tiff?|ai))$"#
    // A Title left by the venue's template (2026-10-11).
    static let templateTitle = #"\b(?:formatting instructions|instructions for (?:authors|\w+ proceedings)|author(?:s'?)? (?:guidelines|kit)|submission (?:template|format)|preparation of papers|paper title|your (?:paper )?title|insert (?:your )?title|template|style ?(?:file|guide)|sample (?:paper|document)|latex class|class file|acmart)\b"#
    // A Title that is an identifier, an address or the publisher, or one word.
    static let notAName = #"^(?:pii|doi|issn|isbn|arxiv)\b|^https?:|\b(?:journals|elsevier|springer|sciencedirect|ieee xplore|aaas)\b|^\S+$"#

    /// What a pdf calls itself: its metadata Title, unless it says nothing or is its template's; '' when none.
    public static func pdfTitle(_ file: String) throws -> String {
        let doc = try open(file)
        let raw = (doc.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String) ?? ""
        let text = raw.collapsingWhitespace()
        guard text.count >= 3, text.count <= 300, RX.test(text, #"\p{L}{2}"#), !RX.test(text, noTitle, ci: true),
              !RX.test(text, templateTitle, ci: true), !RX.test(text, notAName, ci: true) else { return "" }
        return text
    }

    /// The hooks the library takes (Library.InspectPdf / PdfTitle), run off the caller's thread.
    public static let inspect: Library.InspectPdf = { file in try await Task.detached { try inspectPdf(file) }.value }
    public static let title: Library.PdfTitle = { file in try await Task.detached { try pdfTitle(file) }.value }
}
