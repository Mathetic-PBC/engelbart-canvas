import AppKit

// A margin note's @ menu (MATH-21, MATH-22, MATH-27; PaperView noteMention/mentionList/pickMention/openFolder): library
// items, Bart at the start of a highlight's note, and a library folder opened in place.

extension PaperViewController {
    /// The menu opened by what stands before the caret (`@` and up to 30 characters), or closed.
    func noteMention(_ field: NoteField, _ id: String, _ page: Int) {
        guard host?.paperMentionItems("") != nil, let found = NoteText.mentionAt(field.string, caret: field.selectedRange().location) else { closeMention(); return }
        let was = mention
        mention = (id, page, found.query, found.start)
        if was == nil || was!.markId != id || was!.start != found.start { mentionIdx = 0 } else if browse == nil { mentionIdx = 0 }
        if was == nil { host?.paperMentionMenu(open: true) }
        refreshMenu()
    }

    func closeMention() {
        let was = mention != nil
        mention = nil; browse = nil
        menuView.isHidden = true
        if was { host?.paperMentionMenu(open: false) }
    }

    func mentionKey() -> String? { mention.map { "\($0.markId):\($0.start)" } }

    /// The menu's rows: library items (no Zotero row: a note mentions library items), and Bart at the start of a
    /// highlight's note; inside a folder, its level.
    func mentionList() -> [MentionRow] {
        guard let open = mention, let host else { return [] }
        if let b = browse, b.at == mentionKey() {
            return FolderMenu.rows(folderId: b.folderId, folderName: b.folderName, rel: b.rel, listing: b.listing, query: open.query.lowercased())
        }
        let m = marks.find(open.markId)?.mark
        let bart = asksFrom(m) && ((m?.note ?? "") as NSString).substring(to: min(open.start, ((m?.note ?? "") as NSString).length)).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return (host.paperMentionItems(open.query.lowercased()) ?? []).filter { r in (r.kind == .item && !r.rowId.isEmpty && !r.zotero) || (bart && r.kind == .verb && r.verb == "bart") }
    }

    func refreshMenu() {
        let rows = mentionList()
        menuView.rows = rows
        if mentionIdx >= rows.count { mentionIdx = 0 }
        menuView.index = mentionIdx
        let wasHidden = menuView.isHidden
        menuView.isHidden = rows.isEmpty
        if wasHidden && !rows.isEmpty { menuView.rise() }
        placeMenu()
    }

    /// The menu at the field's caret (fieldCaret, scaled with the card): under it, or above it with no room under.
    func placeMenu() {
        guard let open = mention, let f = noteField(open.markId), f.window != nil, !menuView.isHidden else { return }
        let caret = f.firstRect(forCharacterRange: f.selectedRange(), actualRange: nil) // screen
        guard let window = view.window else { return }
        let inWindow = window.convertFromScreen(caret)
        let r = paperArea.convert(inWindow, from: nil)
        let a = paperArea.bounds, size = menuView.preferredSize(maxWidth: a.width - 16)
        var y = r.minY - 4 - size.height
        if y < 8 { y = r.maxY + 4 }
        let x = max(8, min(r.minX, a.width - size.width - 8))
        menuView.frame = NSRect(x: x, y: max(8, min(y, a.height - size.height - 8)), width: size.width, height: size.height)
        paperArea.addSubview(menuView, positioned: .above, relativeTo: nil)
    }

    /// A row picked: its token takes the place of `@query`, then a space; Bart's row writes `@Bart `.
    func pickMention(_ r: MentionRow) {
        if r.kind == .item && r.browsable { openFolder(r.rowId, r.rowName, ""); return }
        if r.kind == .entry && r.dir { openFolder(r.rowId, r.rowName, r.rel); return }
        if r.kind == .back { leaveFolder(); return }
        if r.kind == .note { return }
        let open = mention
        closeMention()
        let bart = r.kind == .verb && r.verb == "bart"
        guard let open, bart || !r.rowId.isEmpty, let f = noteField(open.markId) else { return }
        if view.window?.firstResponder !== f { view.window?.makeFirstResponder(f) }
        let end = f.selectedRange().location
        let start = NoteText.mentionAt(f.string, caret: end)?.start ?? open.start
        guard start <= end else { return }
        let ns = f.string as NSString
        let token: String
        if bart { token = "@Bart " }
        else if (r.kind == .entry || r.kind == .self) && !r.rel.isEmpty { token = NoteText.fileMention(r.kind == .self ? r.entryName : r.name, folderId: r.rowId, rel: r.rel) }
        else { token = NoteText.libMention(r.kind == .self ? r.rowName : r.name, r.rowId) }
        var text = ns.replacingCharacters(in: NSRange(location: start, length: end - start), with: token) as NSString
        var caret = start + (token as NSString).length
        if bart {
            if caret < text.length, text.character(at: caret) == 0x20 { text = text.replacingCharacters(in: NSRange(location: caret, length: 1), with: "") as NSString }
        } else if caret < text.length, text.character(at: caret) == 0x20 { caret += 1 }
        else { text = text.replacingCharacters(in: NSRange(location: caret, length: 0), with: " ") as NSString; caret += 1 }
        f.string = text as String
        f.setSelectedRange(NSRange(location: caret, length: 0))
        if let c = f.card { noteChanged(c, f) }
        closeMention()
    }

    /// The menu goes into `rel` of a library folder: what was typed to find it taken out of the note, the level asked of
    /// the host each time, live.
    func openFolder(_ folderId: String, _ folderName: String, _ rel: String) {
        guard let open = mention, let host else { return }
        if let f = noteField(open.markId) {
            let end = f.selectedRange().location, ns = f.string as NSString
            if end > open.start + 1, open.start < ns.length, ns.character(at: open.start) == 0x40 {
                f.string = ns.replacingCharacters(in: NSRange(location: open.start + 1, length: end - open.start - 1), with: "")
                f.setSelectedRange(NSRange(location: open.start + 1, length: 0))
                marks.update(open.markId) { $0.note = f.string }
                scheduleSave()
            }
        }
        mention = (open.markId, open.page, "", open.start)
        let at = mentionKey() ?? ""
        browse = (at, folderId, folderName, rel, nil)
        mentionIdx = 0
        refreshMenu()
        let accepted = host.paperListFolder(folderId, rel: rel) { [weak self] listing in
            guard let self, let b = self.browse, b.at == at, b.folderId == folderId, b.rel == rel else { return }
            self.browse = (at, folderId, folderName, rel, listing)
            self.mentionIdx = FolderMenu.firstPick(FolderMenu.rows(folderId: folderId, folderName: folderName, rel: rel, listing: listing, query: self.mention?.query ?? ""))
            self.refreshMenu()
        }
        if !accepted { browse = (at, folderId, folderName, rel, FolderListing(error: "This folder could not be read")); refreshMenu() }
    }

    func leaveFolder() {
        guard let b = browse else { return }
        if let up = FolderMenu.parentRel(b.rel) { openFolder(b.folderId, b.folderName, up) } else { browse = nil; mentionIdx = 0; refreshMenu() }
    }

    /// The names now of every item the notes mention: the notes are drawn again when it changes.
    func libKey() -> String {
        var ids = Set<String>(), files = Set<String>()
        for (_, list) in marks.pages { for m in list { guard let note = m.note, !note.isEmpty else { continue }
            for part in NoteText.noteParts(note) {
                if let l = NoteText.libMentionOf(part) { ids.insert(l.id) }
                if let f = NoteText.fileMentionOf(part) { ids.insert(f.folderId); files.insert("\(f.folderId)\t\(f.rel)") }
            }
        } }
        func nameKey(_ id: String) -> String { switch libName(id) { case .none: return "?"; case .some(.none): return "-"; case .some(.some(let n)): return n } }
        func stateKey(_ k: String) -> String {
            let p = k.split(separator: "\t", maxSplits: 1).map(String.init)
            switch host?.paperFileState(folderId: p[0], rel: p.count > 1 ? p[1] : "") { case .none: return "?"; case .some(.folder): return "d"; case .some(.file): return "f"; case .some(.missing): return "-" }
        }
        return (ids.sorted().map { "\($0)\t\(nameKey($0))" } + files.sorted().map { "\($0)\t\(stateKey($0))" }).joined(separator: "\n")
    }

    /// The library or a file's state changed: notes whose mentions read differently are drawn again.
    public func libraryChanged() {
        if libKey() != libDrawn { renderAllMarks() }
    }
}
