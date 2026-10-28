import AppKit
import EngelbartDoc

// A library folder opened in the @ menu (MATH-22; model/rail.js folderRows, firstPick, nameParts, parentRel; DocEditor
// openFolder/browseInto/leaveFolder/upFromFolder/readMention). The line keeps the folder's path, `@Folder/sub/`, in place
// of what was typed to find it; what follows the last `/` narrows the level; `name/` enters a subfolder; Backspace right
// after the path goes up.

public enum FolderMenu {
    public static let MAX_MENTIONS = 10

    /// A library row the @ menu goes into rather than mentions: a folder on this Mac (a repository's clone too), Zotero.
    public static func isBrowsable(_ row: LibRow?) -> Bool { guard let r = row else { return false }; return isZotero(r) || (r.type == "folder" && !(r.folderPath ?? "").isEmpty) }
    public static func isZotero(_ row: LibRow?) -> Bool { row?.id == "zotero" }
    public static func isFolderRow(_ m: MenuItem) -> Bool { m.kind == .item && isBrowsable(m.row) }
    /// The path of the level above `rel` ('' at the top), or nil at the top already.
    public static func parentRel(_ rel: String) -> String? { rel.isEmpty ? nil : rel.jsSplit("/").dropLast().joined(separator: "/") }

    /// The menu inside a folder: back, "Mention this folder", then the level's entries (subfolders first, as listed),
    /// narrowed by the query; cut at 10 with "n more"; "Opening…" while it loads; what went wrong when it cannot be read.
    public static func folderRows(row: LibRow, rel: String, listing: FolderListing?, query: String) -> [MenuItem] {
        let parts = rel.isEmpty ? [] : rel.jsSplit("/")
        let needle = query.trimmed.lowercased()
        var out: [MenuItem] = []
        if needle.isEmpty {
            out.append(MenuItem(kind: .back, key: "back", name: parts.isEmpty ? "All" : (parts.count >= 2 ? parts[parts.count - 2] : row.name), hint: ([row.name] + parts).joined(separator: " / ")))
        }
        func say(_ key: String, _ name: String) -> [MenuItem] { out + [MenuItem(kind: .note, key: "note:\(key)", name: name)] }
        guard let listing else { return say("loading", "Opening…") }
        if let e = listing.error { return say("error", e) }
        if listing.missing { return say("missing", isZotero(row) ? "This collection is no longer in Zotero" : !rel.isEmpty ? "This folder is no longer there" : "This folder is not on this Mac any more") }
        if needle.isEmpty && !isZotero(row) {
            out.append(rel.isEmpty ? MenuItem(kind: .self, key: "self", name: "Mention this folder", row: row)
                       : MenuItem(kind: .self, key: "self:\(rel)", name: "Mention this folder", row: row, rel: rel, entryName: parts.last, dir: true))
        }
        let hits = listing.entries.filter { needle.isEmpty || $0.name.lowercased().contains(needle) || ($0.find ?? "").contains(needle) }
        for e in hits.prefix(MAX_MENTIONS) {
            out.append(MenuItem(kind: .entry, key: "entry:\(e.rel)", name: e.name, row: row, rel: e.rel, zotero: e.zotero, dir: e.dir, hint: e.zotero != nil ? (e.hint ?? "") : nil, entryType: e.type))
        }
        let more = hits.count - min(hits.count, MAX_MENTIONS) + (needle.isEmpty ? max(0, listing.total - listing.entries.count) : 0)
        if more > 0 { out.append(MenuItem(kind: .note, key: "note:more", name: "\(more) more\(needle.isEmpty ? ": type to narrow" : "")")) }
        else if hits.isEmpty { out.append(MenuItem(kind: .note, key: "note:none", name: needle.isEmpty ? "Nothing here to mention" : "Nothing here by that name")) }
        return out
    }

    /// The row the keyboard starts on in a folder: its first entry, else "Mention this folder", else the first.
    public static func firstPick(_ rows: [MenuItem]) -> Int {
        if let at = rows.firstIndex(where: { $0.kind == .entry }) { return at }
        return max(0, rows.firstIndex(where: { $0.kind == .self }) ?? 0)
    }

    /// A long name cut in two: its start (cut with an ellipsis) and its end (the extension and ten characters before it).
    public static func nameParts(_ name: String) -> (head: String, tail: String) {
        if name.len <= 24 { return (name, "") }
        let ext = Rx(#"\.[A-Za-z0-9]{1,8}$"#).match(name)?.str ?? ""
        let keep = min(ext.len + 10, name.len / 2)
        return (name.slice(0, name.len - keep), name.slice(name.len - keep))
    }
}

/// Where the @ menu stands inside a folder: the line's path, what was typed before entering, the level and its listing.
struct Browse {
    var at: String
    var start: Int
    var path: String
    var before: String
    var row: LibRow
    var rel: String
    var listing: FolderListing?
}

extension DocEditorView {
    func mentionKeyOf(_ m: MentionState) -> String { m.field != nil ? "f\(m.field!):\(m.start)" : "\(m.line ?? -1):\(m.start)" }
    var canBrowse: Bool { host != nil }

    /// The menu goes into `rel` of folder `row`: the line (or field) keeps its path, the caret after the last `/`.
    func openFolder(_ row: LibRow, rel: String, before: String? = nil) {
        guard var m = mention else { return }
        let was = before ?? (browse?.at == mentionKeyOf(m) ? browse!.before : m.query)
        let path = Inline.folderPath(row.name, rel)
        putMention(m, path)
        m.query = ""; m.caret = m.start + path.len
        mention = m
        browseInto(m, row: row, rel: rel, before: was)
    }

    func browseInto(_ m: MentionState, row: LibRow, rel: String, before: String) {
        let key = mentionKeyOf(m)
        browse = Browse(at: key, start: m.start, path: Inline.folderPath(row.name, rel), before: before, row: row, rel: rel, listing: nil)
        refreshFolderRows()
        host?.docEditor(self, listFolder: row.id, rel: rel) { [weak self] listing in
            guard let self, let b = self.browse, b.at == key, b.row.id == row.id, b.rel == rel else { return } // gone elsewhere meanwhile
            self.browse?.listing = listing
            self.refreshFolderRows(first: true)
        }
    }

    func refreshFolderRows(first: Bool = false) {
        guard var m = mention, let b = browse else { return }
        m.items = FolderMenu.folderRows(row: b.row, rel: b.rel, listing: b.listing, query: m.query.lowercased())
        m.index = first || m.index >= m.items.count ? FolderMenu.firstPick(m.items) : m.index
        mention = m
        showMenu()
    }

    /// `text` in place of the menu's `@…` (from its `@` to the caret), the caret after it.
    func putMention(_ m: MentionState, _ text: String) {
        if let from = m.field, let field = mentionField {
            let end = min(m.caret, field.string.len)
            field.replaceCharacters(in: NSRange(location: m.start, length: max(0, end - m.start)), with: text)
            core.followText[from] = field.string
            return
        }
        guard let line = m.line else { return }
        let cur = core.lineText(core.lines, line)
        core.writeText(line, cur.slice(0, m.start) + text + cur.slice(min(m.caret, cur.len)), caret: CaretPlace(line: line, offset: m.start + text.len))
        core.activeLine = line
        browsingRedraw = true
        redraw()
        browsingRedraw = false
    }

    /// Back up a level; from the folder's top, back to the whole menu with what was typed before.
    func leaveFolder() {
        guard let b = browse, var m = mention else { return }
        if let up = FolderMenu.parentRel(b.rel) { openFolder(b.row, rel: up, before: b.before); return }
        let text = "@\(b.before)"
        putMention(m, text)
        browse = nil
        m.query = b.before; m.caret = m.start + text.len
        m.items = menuRows(b.before, field: m.field != nil); m.index = 0
        mention = m
        showMenu()
    }

    /// Backspace right after the path's last `/` with nothing typed after it: up a level. → whether it did.
    func upFromFolder(_ at: Int) -> Bool {
        guard let m = mention, m.query.isEmpty, let b = browse, at == b.start + b.path.len else { return false }
        leaveFolder(); return true
    }

    /// What the menu reads in a folder: its query after the path, or `name/` (a subfolder to enter). nil: not in a folder now.
    func readFolderMention(_ text: String, _ caret: Int, line: Int?, field: Int?) -> Bool {
        guard let b = browse, b.at == (field != nil ? "f\(field!):\(b.start)" : "\(line ?? -1):\(b.start)") else { return false }
        switch Inline.folderMentionAt(text, caret, start: b.start, path: b.path) {
        case .into(let name, _)?:
            if let dir = b.listing?.entries.first(where: { $0.dir && $0.name == name }) {
                mention = MentionState(line: line, field: field, query: "", start: b.start, caret: caret, index: 0, items: [])
                browseInto(mention!, row: b.row, rel: dir.rel, before: b.before)
                return true
            }
            return false
        case .query(let q, _)?:
            // Words with a space no entry holds are writing: the menu closes.
            if q.contains(" "), b.listing != nil, !(b.listing!.entries.contains { $0.name.lowercased().contains(q.trimmed.lowercased()) }) { return false }
            mention = MentionState(line: line, field: field, query: q, start: b.start, caret: caret, index: mention?.index ?? 0, items: [])
            refreshFolderRows()
            return true
        case nil: return false
        }
    }
}
