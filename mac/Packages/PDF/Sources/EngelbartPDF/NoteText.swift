import Foundation

// A margin note's text (src/renderer/model/doc.js: noteParts, noteOffset, mentionAt, libMention, fileMention,
// encodeRel/decodeRel, NOTE_AGENT_RE) and the @ menu inside a library folder (src/renderer/model/rail.js folderRows).
// A note is text as typed: only its library mentions are drawn (MATH-21), and a leading @bart on a highlight's note is
// the document's blue label (MATH-27 follow-up). Copied here (the Doc package owns doc.js) because this package depends
// on Core and UI only.

public enum NoteText {
    /// `@[Name](lib:<id>)` — a library item.
    public static let LIB_MENTION = "^@\\[([^\\]\\n]+)\\]\\(lib:([\\w-]+)\\)$"
    /// `@[Name](lib:<folderId>:<rel>)` — a file in a library folder (MATH-22).
    public static let FILE_MENTION = "^@\\[([^\\]\\n]+)\\]\\(lib:([\\w-]+):([\\w.~%/-]+)\\)$"
    static let LIB_SPLIT = "(@\\[[^\\]\\n]+\\]\\(lib:[\\w-]+(?::[\\w.~%/-]+)?\\))"
    static let NOTE_AGENT = "^(\\s*)(@bart)(?=\\s|$)"
    static let MENTION_QUERY = "@([^\\s@\\[\\]]{0,30})$"

    static func re(_ p: String, _ o: NSRegularExpression.Options = []) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: o) }
    static let libRe = re(LIB_MENTION), fileRe = re(FILE_MENTION), splitRe = re(LIB_SPLIT), agentRe = re(NOTE_AGENT, [.caseInsensitive]), queryRe = re(MENTION_QUERY)

    static func groups(_ r: NSRegularExpression, _ s: String) -> [String]? {
        let ns = s as NSString
        guard let m = r.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
    }

    public struct LibMention: Equatable { public var name: String; public var id: String }
    public struct FileMention: Equatable { public var name: String; public var folderId: String; public var rel: String }

    public static func libMentionOf(_ tok: String) -> LibMention? { groups(libRe, tok).map { LibMention(name: $0[1], id: $0[2]) } }
    public static func fileMentionOf(_ tok: String) -> FileMention? { groups(fileRe, tok).map { FileMention(name: $0[1], folderId: $0[2], rel: decodeRel($0[3])) } }

    static func cleanName(_ s: String) -> String { s.replacingOccurrences(of: "[\\[\\]\\n]", with: "", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines) }

    public static func libMention(_ name: String, _ id: String) -> String {
        let n = cleanName(name)
        return "@[\(n.isEmpty ? "Untitled" : n)](lib:\(id))"
    }

    /// encodeURIComponent, with !'()* encoded too, part by part.
    public static func encodeRel(_ rel: String) -> String {
        var allowed = CharacterSet.alphanumerics.intersection(CharacterSet(charactersIn: Unicode.Scalar(0)...Unicode.Scalar(127)))
        allowed.insert(charactersIn: "-_.~")
        return rel.split(separator: "/", omittingEmptySubsequences: true).filter { $0 != "." }
            .map { String($0).addingPercentEncoding(withAllowedCharacters: allowed) ?? String($0) }.joined(separator: "/")
    }

    public static func decodeRel(_ rel: String) -> String {
        rel.split(separator: "/", omittingEmptySubsequences: true).map { String($0).removingPercentEncoding ?? String($0) }.joined(separator: "/")
    }

    public static func fileMention(_ name: String, folderId: String, rel: String) -> String {
        var n = cleanName(name)
        if n.isEmpty { n = (rel.split(separator: "/").last.map(String.init) ?? "").replacingOccurrences(of: "[\\[\\]\\n]", with: "", options: .regularExpression) }
        if n.isEmpty { n = "Untitled" }
        return "@[\(n)](lib:\(folderId):\(encodeRel(rel)))"
    }

    /// The @ menu's query before `caret` (UTF-16) → (query, start where its @ stands), or nil.
    public static func mentionAt(_ text: String, caret: Int) -> (query: String, start: Int)? {
        let ns = text as NSString
        let before = ns.substring(to: max(0, min(caret, ns.length)))
        guard let m = queryRe.firstMatch(in: before, range: NSRange(location: 0, length: (before as NSString).length)) else { return nil }
        return ((before as NSString).substring(with: m.range(at: 1)), (before as NSString).length - m.range.length)
    }

    /// A note's pieces, text and mentions in turn; with `agents` a leading @bart is a piece of its own (any space before
    /// it another).
    public static func noteParts(_ text: String, agents: Bool = false) -> [String] {
        let ns = text as NSString
        func split(_ s: String) -> [String] {
            let n = s as NSString
            var out: [String] = [], at = 0
            for m in splitRe.matches(in: s, range: NSRange(location: 0, length: n.length)) {
                if m.range.location > at { out.append(n.substring(with: NSRange(location: at, length: m.range.location - at))) }
                out.append(n.substring(with: m.range))
                at = m.range.location + m.range.length
            }
            if at < n.length { out.append(n.substring(from: at)) }
            return out
        }
        if agents, let lead = agentRe.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) {
            let sp = ns.substring(with: lead.range(at: 1)), tok = ns.substring(with: lead.range(at: 2))
            return ([sp, tok] + split(ns.substring(from: lead.range.location + lead.range.length))).filter { !$0.isEmpty }
        }
        return split(text).filter { !$0.isEmpty }
    }

    /// The leading @bart of a note, if any → (range of the token, UTF-16).
    public static func agentToken(_ text: String) -> NSRange? {
        agentRe.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length))?.range(at: 2)
    }

    /// Where in a note's text a click lands: `offset` characters into its `part`-th piece; a mention is passed whole.
    public static func noteOffset(_ text: String, part: Int, offset: Int, agents: Bool = false) -> Int {
        let parts = noteParts(text, agents: agents)
        var at = 0
        for i in 0..<min(part, parts.count) { at += (parts[i] as NSString).length }
        if part >= parts.count { return at }
        let p = parts[part], len = (p as NSString).length
        return at + (libMentionOf(p) != nil || fileMentionOf(p) != nil ? len : max(0, min(len, offset)))
    }
}

/* ------------------------------------------------------------------------------------------------ the note's @ menu */

/// A row of a note's @ menu: what the host offers (library items, Bart), or a level of a library folder (MATH-22).
public struct MentionRow: Equatable {
    public enum Kind: String { case item, verb, back, `self`, entry, note }
    public var kind: Kind
    public var key: String
    /// What the row says.
    public var name: String
    /// A second, grey line or trailing text.
    public var hint: String = ""
    /// The library row (items, folder rows): its id, name, and whether it is a folder the menu goes into.
    public var rowId: String = ""
    public var rowName: String = ""
    public var browsable: Bool = false
    public var zotero: Bool = false
    /// Bart's row (kind verb, verb "bart").
    public var verb: String = ""
    /// Inside a folder: the path, its own name ('self' of a subfolder), whether it is a folder.
    public var rel: String = ""
    public var entryName: String = ""
    public var dir: Bool = false
    public var type: String? = nil

    public init(kind: Kind, key: String, name: String, hint: String = "", rowId: String = "", rowName: String = "", browsable: Bool = false,
                zotero: Bool = false, verb: String = "", rel: String = "", entryName: String = "", dir: Bool = false, type: String? = nil) {
        self.kind = kind; self.key = key; self.name = name; self.hint = hint; self.rowId = rowId; self.rowName = rowName
        self.browsable = browsable; self.zotero = zotero; self.verb = verb; self.rel = rel; self.entryName = entryName; self.dir = dir; self.type = type
    }

    /// A library item the menu offers.
    public static func item(id: String, name: String, browsable: Bool = false, zotero: Bool = false, hint: String = "") -> MentionRow {
        MentionRow(kind: .item, key: "item:\(id)", name: name, hint: hint, rowId: id, rowName: name, browsable: browsable, zotero: zotero)
    }
    /// Bart, at the start of a highlight's note.
    public static let bart = MentionRow(kind: .verb, key: "verb:bart", name: "Bart", verb: "bart")
}

/// One level of a library folder as main lists it (store/folder-files.cjs listFolder).
public struct FolderListing: Equatable {
    public struct Entry: Equatable { public var name: String; public var rel: String; public var dir: Bool; public var type: String?
        public init(name: String, rel: String, dir: Bool = false, type: String? = nil) { self.name = name; self.rel = rel; self.dir = dir; self.type = type }
    }
    public var entries: [Entry] = []
    public var total: Int = 0
    public var missing: Bool = false
    public var error: String? = nil
    public init(entries: [Entry] = [], total: Int = 0, missing: Bool = false, error: String? = nil) { self.entries = entries; self.total = total; self.missing = missing; self.error = error }
}

public enum FolderMenu {
    public static let MAX_MENTIONS = 50

    /// The @ menu inside a library folder (rail.js folderRows). `listing` nil while it is on its way.
    public static func rows(folderId: String, folderName: String, rel: String, listing: FolderListing?, query: String) -> [MentionRow] {
        let parts = rel.isEmpty ? [] : rel.split(separator: "/").map(String.init)
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var out: [MentionRow] = needle.isEmpty ? [MentionRow(kind: .back, key: "back", name: parts.isEmpty ? "All" : (parts.count >= 2 ? parts[parts.count - 2] : folderName), hint: ([folderName] + parts).joined(separator: " / "))] : []
        func say(_ key: String, _ name: String) -> [MentionRow] { out + [MentionRow(kind: .note, key: "note:\(key)", name: name)] }
        guard let listing else { return say("loading", "Opening…") }
        if let e = listing.error { return say("error", e.isEmpty ? "This folder could not be read" : e) }
        if listing.missing { return say("missing", rel.isEmpty ? "This folder is not on this Mac any more" : "This folder is no longer there") }
        if needle.isEmpty {
            out.append(rel.isEmpty
                ? MentionRow(kind: .self, key: "self", name: "Mention this folder", rowId: folderId, rowName: folderName)
                : MentionRow(kind: .self, key: "self:\(rel)", name: "Mention this folder", rowId: folderId, rowName: folderName, rel: rel, entryName: parts.last ?? "", dir: true))
        }
        let hits = listing.entries.filter { needle.isEmpty || $0.name.lowercased().contains(needle) }
        for e in hits.prefix(MAX_MENTIONS) {
            out.append(MentionRow(kind: .entry, key: "entry:\(e.rel)", name: e.name, rowId: folderId, rowName: folderName, rel: e.rel, dir: e.dir, type: e.type))
        }
        let more = hits.count - min(hits.count, MAX_MENTIONS) + (needle.isEmpty ? max(0, listing.total - listing.entries.count) : 0)
        if more > 0 { out.append(MentionRow(kind: .note, key: "note:more", name: "\(more) more\(needle.isEmpty ? ": type to narrow" : "")")) }
        else if hits.isEmpty { out.append(MentionRow(kind: .note, key: "note:none", name: needle.isEmpty ? "Nothing here to mention" : "Nothing here by that name")) }
        return out
    }

    /// The row the keyboard starts on in a folder: its first entry, else "Mention this folder", else the first.
    public static func firstPick(_ rows: [MentionRow]) -> Int {
        if let i = rows.firstIndex(where: { $0.kind == .entry }) { return i }
        return max(0, rows.firstIndex(where: { $0.kind == .self }) ?? -1)
    }

    /// The level above `rel` ('' at the top), or nil at the top already.
    public static func parentRel(_ rel: String) -> String? {
        if rel.isEmpty { return nil }
        return rel.split(separator: "/").dropLast().joined(separator: "/")
    }
}
