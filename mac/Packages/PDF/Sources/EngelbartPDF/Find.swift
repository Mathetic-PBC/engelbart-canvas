import Foundation
import EngelbartDoc

// Find in a pdf and a link's section (PaperView.jsx find/showSection; src/renderer/model/find.js; the typography fold is
// EngelbartDoc.PassageText, the one port of src/shared/passage-text.cjs). Offsets are UTF-16, as in JS strings.

public struct FindSpot: Equatable, Sendable {
    public var page: Int
    public var from: Int
    /// nil: to the end of the page.
    public var to: Int?
    public init(page: Int, from: Int, to: Int?) { self.page = page; self.from = from; self.to = to }
}

public enum PaperFind {
    /// Space in the query matches any run of space or none (lines and words are separate runs), and a word may be broken
    /// by a hyphen at the end of a line ("construc-\ntion"): the hyphen-newline rule (2026-09-22, 49/56 → pdftotext's count).
    public static func findPattern(_ query: String) -> NSRegularExpression? {
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }
        if words.isEmpty { return nil }
        let src = words.map { w in w.map { NSRegularExpression.escapedPattern(for: String($0)) }.joined(separator: "(?:-\\n)?") }.joined(separator: "\\s*")
        return try? NSRegularExpression(pattern: src, options: [.caseInsensitive])
    }

    /// Where a query matches, page by page in order. A passage of three or more words found nowhere is matched again
    /// typography-folded (curly quotes, dashes, ligatures, soft hyphens: passage-text.cjs matchPassage).
    public static func matchSpots(_ query: String, pages: [(page: Int, text: String)]) -> [FindSpot] {
        var spots: [FindSpot] = []
        if let re = findPattern(query) {
            for (page, text) in pages {
                for m in re.matches(in: text, range: NSRange(location: 0, length: (text as NSString).length)) where m.range.length > 0 {
                    spots.append(FindSpot(page: page, from: m.range.location, to: m.range.location + m.range.length))
                }
            }
        }
        if !spots.isEmpty || query.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: .whitespacesAndNewlines).filter({ !$0.isEmpty }).count < 3 { return spots }
        for (page, text) in pages { for hit in PassageText.matchPassage(text, query) { spots.append(FindSpot(page: page, from: hit.start, to: hit.end)) } }
        return spots
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

    public static let SECTION_PAGES = 6

    /// The stretch a section covers, page by page; nil when `to` matches nowhere after the start or too far on.
    public static func sectionSpans(_ start: FindSpot?, _ ends: [FindSpot]) -> [FindSpot]? {
        guard let start else { return nil }
        let startTo = start.to ?? Int.max
        guard let end = ends.first(where: { $0.page > start.page || ($0.page == start.page && $0.from >= startTo) }),
              end.page - start.page <= SECTION_PAGES else { return nil }
        if end.page == start.page { return [FindSpot(page: start.page, from: start.from, to: end.from)] }
        var spans = [FindSpot(page: start.page, from: start.from, to: nil)]
        if start.page + 1 < end.page { for page in (start.page + 1)..<end.page { spans.append(FindSpot(page: page, from: 0, to: nil)) } }
        spans.append(FindSpot(page: end.page, from: 0, to: end.from))
        return spans
    }

    /// A link's target as the gate holds it: the passage, and the start of the section after it when there is one.
    public static func targetKey(_ find: String?, _ to: String?) -> String {
        guard let find, !find.isEmpty else { return "" }
        if let to, !to.isEmpty { return "\(find)\n\(to)" }
        return find
    }
}

/// A link's passage waiting for the pages (find.js createTargetGate): found once, after drawing, until cleared and given again.
public final class TargetGate {
    private var target = "", done = "", ready = false
    public init() {}
    private func take() -> String? {
        if !ready || target.isEmpty || target == done { return nil }
        done = target
        return target
    }
    @discardableResult public func set(_ next: String?) -> String? { target = next ?? ""; if target.isEmpty { done = "" }; return take() }
    public func drawing() { ready = false }
    public func drawn() -> String? { ready = true; return take() }
    public func peek() -> String? { !target.isEmpty && target != done ? target : nil }
    public func claim() { if !target.isEmpty { done = target } }
}

