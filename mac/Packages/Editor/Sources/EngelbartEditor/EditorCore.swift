import Foundation
import EngelbartCore
import EngelbartDoc

// The document engine of DocEditor.jsx without the page: one markdown string, its lines, the line the caret is on, undo,
// and every edit the keyboard, a paste or a button makes. The view (DocEditorView) draws the lines and turns NSTextView
// events into calls here; nothing here knows AppKit, so the Electron tests that drove DocEditor with stand-ins drive this.

public final class EditorCore {
    public struct Hooks {
        /// props.onChange: the whole text, after every edit.
        public var changed: (String) -> Void = { _ in }
        /// props.onAsk; nil in an editor that cannot ask (a post-it, a read-only document).
        public var ask: ((AskRequest) -> Void)? = nil
        /// props.onRoute: the router's pick comes back through the completion (nil: it failed).
        public var route: ((RouteRequest, @escaping (RoutePick?) -> Void) -> Void)? = nil
        public var routeGone: (String) -> Void = { _ in }
        public var stopAsk: (String) -> Void = { _ in }
        /// props.onBuild; nil where nothing can be built.
        public var build: ((BuildRequest) -> Void)? = nil
        /// `@Note name` + Enter: the note is made; its name comes back (nil: none made).
        public var noteVerb: ((String, @escaping (String?) -> Void) -> Void)? = nil
        /// A row picked in the @ menu comes into the workspace.
        public var mentionPicked: (MenuItem) -> Void = { _ in }
        /// Another document's text, for a run handed on after the person left it (props.docTextOf).
        public var docTextOf: (String) -> String? = { _ in nil }
        /// Another document's onChange.
        public var changeDoc: (String, String) -> Void = { _, _ in }
        /// A question asked: the view keeps its row where it was on screen and focuses the reply when the answer lands.
        public var asked: (String) -> Void = { _ in }
        public init() {}
    }

    public struct Editing: Equatable { public var q: Int; public var original: String; public var under: [String]; public var mark: Int }

    public var hooks = Hooks()
    public internal(set) var docKey: String
    public internal(set) var text: String
    public var readOnly = false
    /// props.autoCollapse: titled conversations left open are collapsed once each time a document is shown.
    public var autoCollapseOn = false
    public var models: QuestionModels?
    public var builds: [String: BuildState] = [:]
    public var asks: [String: AskProgress] = [:]
    /// The line the caret is on (it shows its source), or nil.
    public var activeLine: Int?
    /// Where the caret goes once the next draw is done; the view takes it (and clears it).
    public var caret: CaretPlace?
    /// The caret as the view last reported it (caretInfo), for undo's caret.
    public var lastSelection: DocSelection?
    public internal(set) var history: [(text: String, caret: DocPoint?)] = []
    public internal(set) var future: [String] = []
    public var editing: Editing?
    /// A conversation marked to be taken away by a second Backspace/Delete.
    public var armed: (from: Int, to: Int, head: Int)?
    /// What is typed in each conversation's reply field, by its first line; images pasted there.
    public var followText: [Int: String] = [:]
    public var followImages: [Int: [(n: Int, id: String?)]] = [:]
    /// A model picked under a reply field's chip, by its thread's first line.
    public var followChoice: [Int: (model: String, effort: String)] = [:]
    /// What is ticked on a live card, by its question's line.
    public var cardPicks: [Int: [String]] = [:]
    /// Deep research searches counting down: askId → seconds left (waitResearch).
    public internal(set) var waits: [String: (ask: AskRequest, left: Int)] = [:]
    var autoFolded: String? = nil
    var autoWait: (docKey: String, ids: Set<String>)? = nil

    public init(docKey: String = "", text: String = "") {
        self.docKey = docKey
        self.text = text
    }

    // MARK: document access

    public var lines: [String] { text.jsSplit("\n") }
    private var parsedKey: [String]? = nil
    private var parsedCache: [ParsedLine] = []
    private var threadsCache: [DocThread] = []
    private var collapsedCache: (key: [String], builds: [String: BuildState], held: Set<Int>)? = nil
    /// Each line read in place (parseLines), kept for the array it was read from.
    public func parsed(_ ls: [String]? = nil) -> [ParsedLine] {
        let ls = ls ?? lines
        if let key = parsedKey, key == ls { return parsedCache }
        parsedKey = ls; parsedCache = Doc.parseLines(ls); threadsCache = Doc.threads(ls, parsedCache)
        return parsedCache
    }
    public func threads(_ ls: [String]? = nil) -> [DocThread] { let ls = ls ?? lines; _ = parsed(ls); return threadsCache }

    /// Replace the shown document with another (docKey changed): its question being edited goes back as it was, history
    /// and the caret line go.
    public func setDocument(key: String, text: String) {
        dropEdit()
        docKey = key
        self.text = text
        history = []; future = []; caret = nil; activeLine = nil; armed = nil
        autoCollapse()
    }

    /// The text changed outside (an answer landed, another window saved, the host's own edit). An answer arriving above
    /// the caret's line keeps the caret on that same unchanged line (head/tail diff).
    public func receive(text next: String) {
        if next == text { return }
        let before = lines
        text = next
        if editing != nil { trackEdit() }
        let after = lines
        var head = 0, tail = 0
        while head < before.count && head < after.count && before[head] == after[head] { head += 1 }
        while tail < before.count - head && tail < after.count - head && before[before.count - 1 - tail] == after[after.count - 1 - tail] { tail += 1 }
        func moved(_ line: Int) -> Int? { line < head ? line : line >= before.count - tail ? line + after.count - before.count : nil }
        if caret == nil, let sel = lastSelection, sel.sameLine, let a = moved(sel.anchor.line) {
            let s = sel.start.offset, e = sel.end.offset
            caret = CaretPlace(line: a, sel: (s, e), back: sel.backward)
            if activeLine != nil { activeLine = a }
        } else if let line = activeLine, caret == nil {
            activeLine = moved(line)
        }
        autoCollapse()
    }

    // MARK: locks and the document's ends

    func isRunning(_ thread: DocThread) -> Bool { thread.turns.contains { $0.pending != nil || ($0.build != nil && !(builds[$0.build!]?.done ?? false)) } }
    func isBuilding(_ thread: DocThread) -> Bool { thread.turns.contains { $0.build != nil && !(builds[$0.build!]?.done ?? false) } }
    func isCollapsed(_ thread: DocThread) -> Bool { thread.titleLine >= 0 && thread.folded && !isBuilding(thread) }

    /// The lines a collapsed conversation hides.
    public func collapsedOf(_ ls: [String]) -> Set<Int> {
        if let c = collapsedCache, c.key == ls, c.builds == builds { return c.held }
        var held = Set<Int>()
        for thread in threads(ls) where isCollapsed(thread) { for i in thread.from...thread.to { held.insert(i) } }
        collapsedCache = (ls, builds, held)
        return held
    }

    /// Lines the person cannot type in (lockedAt): a Build, a title, every answer line, a collapsed conversation's lines,
    /// an asked question (unless being edited), a pending line.
    public func lockedAt(_ ls: [String], _ i: Int) -> Bool {
        if let e = editing, e.q == i { return false }
        let ps = parsed(ls)
        let p = i >= 0 && i < ps.count ? ps[i] : Doc.parseLine("")
        if p.type == .build || p.type == .title || p.type == .reply || collapsedOf(ls).contains(i) { return true }
        if p.type == .bart { return i + 1 < ls.count && (ps[i + 1].type == .pending || ps[i + 1].type == .reply) }
        return Doc.isAnswer(p.type) && p.type != .quote
    }

    /// A card is closed by its foot, never by a line the caret can sit on; a code block neither.
    public func endsOnCard(_ ls: [String]) -> Bool {
        let last = ls.count - 1
        let p = last >= 0 ? parsed(ls)[last] : Doc.parseLine("")
        return lockedAt(ls, last) || p.type == .reply || p.type == .fence
    }

    /// A document never ends on a card (a line of its own after it) nor starts on a locked line (select-all and typing
    /// above it need one). → whether the text changed.
    @discardableResult
    public func normalize() -> Bool {
        let ls = lines
        if endsOnCard(ls) { text += "\n"; hooks.changed(text); return true }
        if lockedAt(ls, 0) {
            if let c = caret { caret = CaretPlace(line: c.line + 1, sel: (c.a, c.b), back: c.back) }
            if let a = activeLine { activeLine = a + 1 }
            text = "\n" + text; hooks.changed(text); return true
        }
        return false
    }

    // MARK: changes and undo

    /// One undo step: the text before it and where the caret was. `undo`: an edited question asked again is one step back
    /// to before it was edited ({ text, mark }).
    public func setDoc(_ next: String, caret place: CaretPlace? = nil, undo: (text: String, mark: Int)? = nil) {
        if next != text {
            if let undo { history.removeSubrange(min(history.count, undo.mark)...) }
            history.append(undo.map { (text: $0.text, caret: nil) } ?? (text: text, caret: lastSelection?.anchor))
            if history.count > 200 { history.removeFirst(); if editing != nil { editing!.mark = max(0, editing!.mark - 1) } }
            future = []
            text = next
            hooks.changed(text)
        }
        if let place { caret = place }
    }
    public func setLines(_ caret: CaretPlace? = nil, _ fn: ([String]) -> [String]) { setDoc(fn(lines).joined(separator: "\n"), caret: caret) }
    /// Line `i` with different text, keeping its kind.
    public func writeText(_ i: Int, _ t: String, caret place: CaretPlace? = nil) {
        setLines(place) { ls in let ps = Doc.parseLines(ls); return ls.enumerated().map { j, l in j == i ? Doc.sameLine(ps[j], t) : l } }
    }

    public func undo() {
        // A question in edit mode with nothing typed into it any more: ⌘Z takes it out of edit mode.
        if let e = editing, history.count <= e.mark { cancelEdit(); return }
        guard let h = history.popLast() else { return }
        future.append(text)
        text = h.text
        hooks.changed(text)
        if let c = h.caret { caret = CaretPlace(line: c.line, offset: c.offset); activeLine = c.line }
    }
    public func redo() {
        guard let f = future.popLast() else { return }
        history.append((text: text, caret: nil))
        text = f
        hooks.changed(text)
    }
    public var canUndo: Bool { !history.isEmpty }
    public var canRedo: Bool { !future.isEmpty }

    // MARK: typing (editorInput)

    func lineText(_ ls: [String], _ i: Int) -> String {
        guard i >= 0 && i < ls.count else { return "" }
        return Doc.lineText(parsed(ls)[i], ls[i])
    }

    /// The caret's line now reads `typed` (its lineText), the caret at `offset` in it. The marker rules of a row apply: the
    /// space that finishes a marker on an empty row is the marker's, a marker typed at the head re-types the row, `- []`
    /// and `* x` are stored as the row they make, and the caret moves by the difference in the markers. `bulk`: a range was
    /// deleted, not a character (a row it empties is a plain empty line).
    public func typeLine(_ i: Int, _ typedIn: String, caret offset: Int, bulk: Bool = false) {
        var ls = lines
        guard i >= 0 && i < ls.count, !readOnly, !lockedAt(ls, i) else { return }
        let psOld = parsed(ls)
        let p = psOld[i], was = ls[i]
        var txt = typedIn
        var strip = 0, cleared = false
        var line: String
        if p.type == .reply { line = Doc.sameLine(p, txt) }
        else if !Doc.isMarked(p.type) { line = txt }
        else if bulk && txt.trimmed.isEmpty { cleared = true; line = "" }
        else {
            // The space that finishes a marker the person is still typing belongs to the marker: an empty row never starts with one.
            if p.text.isEmpty, let lead = Rx(#"^ +"#).match(txt) { strip += lead.str.len; txt = txt.slice(lead.str.len) }
            if let again = Doc.retypedRow(p, txt), offset == strip + again.ate { strip += again.ate; line = again.line }
            else { line = Doc.sameLine(p, txt) }
        }
        ls[i] = line
        var place = CaretPlace(line: i, offset: offset)
        if strip > 0 || cleared { place = CaretPlace(line: i, offset: cleared ? 0 : max(0, offset - strip)) }
        let psNew = Doc.parseLines(ls), inCode = Doc.isCode(psNew[i]) || Doc.isFence(psNew[i])
        if !inCode { ls[i] = Doc.canonicalLine(ls[i]) }
        let now = ls[i], before = p, after = inCode ? psNew[i] : Doc.parseLine(now)
        let grew = (now.len - Doc.lineText(after, now).len) - (was.len - Doc.lineText(before, was).len)
        if grew != 0 { place = CaretPlace(line: i, offset: max(0, place.a - grew)) }
        setDoc(ls.joined(separator: "\n"), caret: place)
        activeLine = i
    }

    /// Text typed with `sel` selected (a keystroke, an IME commit, a one-line paste of the browser's own kind).
    public func insert(_ typed: String, at sel: DocSelection) {
        var s = sel
        if !s.sameLine {
            guard let at = deleteSelection(s, bulk: true) else { return }
            s = DocSelection(line: at.line, offset: at.a)
        }
        let ls = lines, i = s.anchor.line
        guard i >= 0 && i < ls.count, !lockedAt(ls, i) else { return }
        let p = parsed(ls)[i]
        if p.type == .img && s.collapsed { besidePicture(i, s.anchor.offset, typed); return }
        let cur = lineText(ls, i), a = min(s.start.offset, cur.len), b = min(s.end.offset, cur.len)
        typeLine(i, cur.slice(0, a) + typed + cur.slice(b), caret: a + typed.len, bulk: typed.isEmpty && a != b)
    }

    // MARK: deleting across lines

    /// The selection when it runs from a line of text to another over whole conversations: what deleteAcross takes.
    func across(_ sel: DocSelection) -> (start: DocPoint, end: DocPoint, blocks: [(t: DocThread, from: Int, to: Int)])? {
        let start = sel.start, end = sel.end
        if start.line == end.line { return nil }
        let ls = lines
        let all = threads(ls).map { (t: $0, from: $0.titleLine >= 0 ? $0.titleLine : $0.from, to: $0.to) }
        func inOne(_ j: Int) -> Bool { all.contains { j >= $0.from && j <= $0.to } || lockedAt(ls, j) }
        let blocks = all.filter { $0.from > start.line && $0.to < end.line }
        return inOne(start.line) || inOne(end.line) || blocks.isEmpty ? nil : (start, end, blocks)
    }

    /// What such a selection holds as the document's own lines (cut or copied with it): pasted back here, its
    /// conversations are conversations again. One at work is left out.
    public func acrossSource(_ sel: DocSelection) -> String? {
        guard let a = across(sel) else { return nil }
        let ls = lines
        var busy = Set<Int>()
        for b in a.blocks where isRunning(b.t) { for j in b.from...b.to { busy.insert(j) } }
        let mid = (a.start.line + 1 < a.end.line) ? (a.start.line + 1..<a.end.line).filter { !busy.contains($0) }.map { ls[$0] } : []
        return ([lineText(ls, a.start.line).slice(a.start.offset)] + mid + [lineText(ls, a.end.line).slice(0, a.end.offset)]).joined(separator: "\n")
    }

    /// A selection across lines deleted (Backspace, Delete, Cut, typing over it). Over whole conversations (deleteAcross):
    /// the two ends join, a conversation at work between them stays. Otherwise the lines between go, but an answer, an
    /// asked question or anything locked stays unless its whole conversation is inside the selection and not at work.
    /// → where the caret is, or nil when nothing was done.
    @discardableResult
    public func deleteSelection(_ sel: DocSelection, bulk: Bool = true) -> CaretPlace? {
        if readOnly { return nil }
        let ls = lines, ps = parsed(ls)
        if let a = across(sel) {
            var keep: [String] = []
            for b in a.blocks where isRunning(b.t) { for j in b.from...b.to { keep.append(ls[j]) } }
            let head = lineText(ls, a.start.line).slice(0, a.start.offset), tail = lineText(ls, a.end.line).slice(a.end.offset)
            let out = Array(ls[..<a.start.line]) + [Doc.sameLine(ps[a.start.line], head + tail)] + keep + Array(ls[(a.end.line + 1)...])
            armed = nil
            let place = CaretPlace(line: a.start.line, offset: head.len)
            setDoc(out.joined(separator: "\n"), caret: place)
            activeLine = a.start.line
            return place
        }
        let start = sel.start, end = sel.end
        if start.line == end.line {
            let i = start.line
            if lockedAt(ls, i) { return nil }
            let cur = lineText(ls, i)
            typeLine(i, cur.slice(0, start.offset) + cur.slice(end.offset), caret: start.offset, bulk: bulk)
            return caret
        }
        // A conversation wholly inside the selection goes with it (2026-10-15, David), as a picture does; not one at work.
        var whole = Set<Int>()
        for t in threads(ls) {
            let from = t.titleLine >= 0 ? t.titleLine : t.from
            if from >= start.line && t.to <= end.line && !isRunning(t) { for j in from...t.to { whole.insert(j) } }
        }
        var out: [String] = []
        var place: CaretPlace? = nil
        let startLocked = lockedAt(ls, start.line) && !whole.contains(start.line), endLocked = lockedAt(ls, end.line) && !whole.contains(end.line)
        for j in ls.indices {
            if j < start.line || j > end.line { out.append(ls[j]); continue }
            if whole.contains(j) { continue }
            if lockedAt(ls, j) { out.append(ls[j]); continue }
            if j == start.line {
                let head = lineText(ls, j).slice(0, start.offset)
                let tail = endLocked ? "" : lineText(ls, end.line).slice(end.offset)
                var line = Doc.sameLine(ps[j], head + tail)
                if Doc.isMarked(ps[j].type) && bulk && (head + tail).trimmed.isEmpty { line = "" }
                place = CaretPlace(line: out.count, offset: Doc.isMarked(ps[j].type) && line.isEmpty ? 0 : head.len)
                out.append(Doc.isCode(ps[j]) || Doc.isFence(ps[j]) ? line : Doc.canonicalLine(line))
                continue
            }
            if j == end.line && startLocked {
                let tail = lineText(ls, j).slice(end.offset)
                place = CaretPlace(line: out.count, offset: 0)
                out.append(Doc.sameLine(ps[j], tail))
            }
        }
        if out.isEmpty { out.append("") }
        if place == nil { place = CaretPlace(line: min(start.line, out.count - 1), offset: 0) }
        armed = nil
        setDoc(out.joined(separator: "\n"), caret: place)
        activeLine = place!.line
        return place
    }

    // MARK: blocks taken away whole

    /// The conversation whose last line is `end`, or whose first line (its title line, if any) is `start`; not one at work.
    public func blockAt(_ ls: [String], end: Int? = nil, start: Int? = nil) -> (thread: DocThread, from: Int, to: Int)? {
        guard let t = threads(ls).first(where: { end != nil ? $0.to == end! : ($0.titleLine >= 0 ? $0.titleLine : $0.from) == start }), !isRunning(t) else { return nil }
        return (t, t.titleLine >= 0 ? t.titleLine : t.from, t.to)
    }
    func armedIs(_ b: (thread: DocThread, from: Int, to: Int)) -> Bool { armed.map { $0.from == b.from && $0.to == b.to } ?? false }
    public func disarm() { armed = nil }
    /// Still that conversation where it was; else unmarked.
    public func checkArmed() {
        guard let a = armed else { return }
        if let b = blockAt(lines, start: a.from), b.to == a.to { return }
        armed = nil
    }
    func dropBlock(_ b: (thread: DocThread, from: Int, to: Int), caret place: CaretPlace) {
        armed = nil
        setLines(place) { x in let out = x.enumerated().filter { $0.offset < b.from || $0.offset > b.to }.map { $0.element }; return out.isEmpty ? [""] : out }
        activeLine = place.line
    }

    // MARK: rows

    /// Tab / Shift-Tab on a row: depth ±1 (0…8), never deeper than one under the row above; its nested rows move with it.
    public func indent(_ i: Int, _ dir: Int) {
        setLines { ls in
            let ps = Doc.parseLines(ls)
            guard i < ps.count, Doc.isMarked(ps[i].type) else { return ls }
            let p = ps[i], nd = max(0, min(8, p.depth + dir))
            if nd == p.depth { return ls }
            if dir > 0 { let prev = i > 0 ? ps[i - 1] : Doc.parseLine(""); if !Doc.isMarked(prev.type) || nd > prev.depth + 1 { return ls } }
            var out = ls
            var np = p; np.depth = nd
            out[i] = Doc.sameLine(np, p.text)
            var j = i + 1
            while j < ls.count { let q = ps[j]; if !Doc.isMarked(q.type) || q.depth <= p.depth { break }; var nq = q; nq.depth = max(0, min(8, q.depth + dir)); out[j] = Doc.sameLine(nq, q.text); j += 1 }
            return out
        }
    }
    /// Tab in code: two spaces at the caret; Shift-Tab takes up to two (or a tab) off the line's start.
    public func indentCode(_ i: Int, _ cur: String, _ a: Int, _ b: Int, out: Bool) {
        if !out { writeText(i, cur.slice(0, a) + "  " + cur.slice(b), caret: CaretPlace(line: i, offset: a + 2)); return }
        let n = Rx(#"^ {1,2}|^\t"#).match(cur)?.str.len ?? 0
        if n == 0 { return }
        writeText(i, cur.slice(n), caret: CaretPlace(line: i, sel: (max(0, a - n), max(0, b - n))))
    }
    /// ⌘B / ⌘I: the selection wrapped in `mark`, still selected.
    public func wrap(_ i: Int, _ cur: String, _ st: Int, _ en: Int, _ mark: String) {
        writeText(i, cur.slice(0, st) + mark + cur.slice(st, en) + mark + cur.slice(en), caret: CaretPlace(line: i, sel: (st + mark.len, en + mark.len)))
    }
    /// ⌘K: `[selection](url)` (`link` when nothing is selected), `url` selected.
    public func link(_ i: Int, _ cur: String, _ st: Int, _ en: Int) {
        let sel = cur.slice(st, en).isEmpty ? "link" : cur.slice(st, en)
        let a = st + sel.len + 3
        writeText(i, cur.slice(0, st) + "[\(sel)](url)" + cur.slice(en), caret: CaretPlace(line: i, sel: (a, a + 3)))
    }
    public func removeLine(_ i: Int) { setLines { ls in ls.count > 1 ? ls.enumerated().filter { $0.offset != i }.map { $0.element } : [""] } }
    public func toggleTodo(_ i: Int) {
        setLines { ls in ls.enumerated().map { j, l in guard j == i else { return l }; let p = Doc.parseLine(l); return Doc.todoLine(p.depth, !p.done, p.text) } }
    }

    // MARK: pictures

    /// Text typed or pasted beside a picture alone on its line: its own line(s), above when the caret was before it.
    public func besidePicture(_ i: Int, _ at: Int, _ typed: String) {
        let parts = typed.replacingOccurrences(of: "\r", with: "").jsSplit("\n")
        let k = at > 0 ? i + 1 : i, end = k + parts.count - 1
        setLines(CaretPlace(line: end, offset: parts.last!.len)) { x in var out = x; out.insert(contentsOf: parts, at: min(k, out.count)); return out }
        activeLine = end
    }

    /// A pasted picture saved as `id` (the host named it `label`) placed at `at`: inline in a row or a question line (with
    /// a space either side as needed), else on its own line followed by an empty one; on an answer, under its conversation.
    /// → where the next picture of the same paste goes.
    @discardableResult
    public func placeImage(id: String, label: String, at: DocPoint) -> DocPoint {
        let token = "![\(label)](img:\(id))"
        let ls = lines
        var i = min(at.line, ls.count - 1)
        var line = ls[i], p = Doc.parseLine(line)
        let under = p.type == .reply
        if under, let t = threads(ls).first(where: { i >= $0.from && i <= $0.to }) { i = t.to; line = ls[i]; p = Doc.parseLine(line) }
        if !under && (Doc.isMarked(p.type) || p.type == .bart) {
            let cur = Doc.lineText(p, line), a = min(at.offset, cur.len)
            let ins = (a > 0 && !Rx(#"\s$"#).test(cur.slice(0, a)) ? " " : "") + token + " "
            writeText(i, cur.slice(0, a) + ins + cur.slice(a), caret: CaretPlace(line: i, offset: a + ins.len))
            return DocPoint(line: i, offset: a + ins.len)
        }
        if line.trimmed.isEmpty {
            setLines(CaretPlace(line: i + 1, offset: 0)) { x in var out = x; out.replaceSubrange(i...i, with: [token, ""]); return out }
            activeLine = i + 1
            return DocPoint(line: i + 1, offset: 0)
        }
        setLines(CaretPlace(line: i + 2, offset: 0)) { x in var out = x; out.insert(contentsOf: [token, ""], at: i + 1); return out }
        activeLine = i + 2
        return DocPoint(line: i + 2, offset: 0)
    }

    /// The label the next pasted picture takes: `Attachment n`, n one more than the images the document holds.
    public func nextAttachmentLabel(extra: Int = 0) -> String {
        "Attachment \(Rx(#"\]\(img:"#).matchAll(text).count + 1 + extra)"
    }

    /// Where a picture line can be dragged to: before line j, unless inside a conversation or a code block (imgDropGaps).
    public static func imgDropGaps(_ ls: [String]) -> Set<Int> {
        let ps = Doc.parseLines(ls)
        var shut = Set<Int>()
        for t in Doc.threads(ls, ps) { let from = (t.titleLine >= 0 ? t.titleLine : t.from) + 1; if from <= t.to { for j in from...t.to { shut.insert(j) } } }
        for b in Doc.codeBlocks(ls) { for j in (b.open + 1)...b.close { shut.insert(j) } }
        return Set((0...ls.count).filter { !shut.contains($0) })
    }
    /// Line `i` moved to stand before line `j` (as counted before the move).
    public static func moveLineTo(_ ls: [String], _ i: Int, _ j: Int) -> [String] {
        if j == i || j == i + 1 || i < 0 || i >= ls.count { return ls }
        var out = ls
        let line = out.remove(at: i)
        out.insert(line, at: j > i ? j - 1 : j)
        return out
    }
    public func moveImage(_ i: Int, before j: Int) {
        let next = EditorCore.moveLineTo(lines, i, j)
        if next != lines { setDoc(next.joined(separator: "\n")); activeLine = nil }
    }
    /// An image's corner let go: its width written into its line (`![name|w=W](src)`).
    public func resizeImage(_ i: Int, width: Int) {
        setLines { ls in ls.enumerated().map { j, l in
            guard j == i else { return l }
            let p = Doc.parseLine(l)
            return p.type == .img ? "![\(EditorText.imgParts(p.text).name)|w=\(width)](\(p.src))" : l
        } }
    }

    // MARK: drops

    /// `text` let go at `at`: in that line's text with a space either side where a word would touch it; on a line of its
    /// own under a locked line (under its conversation); beside a picture as its own line.
    public func placeDropped(_ dropped: String, at: DocPoint) {
        let ls = lines
        var i = min(max(0, at.line), ls.count - 1)
        let line = ls[i], p = parsed(ls)[i]
        if lockedAt(ls, i) {
            if let t = threads(ls).first(where: { i >= $0.from && i <= $0.to }) { i = max(i, t.to) }
            setLines(CaretPlace(line: i + 1, offset: dropped.len)) { x in var out = x; out.insert(dropped, at: i + 1); return out }
            activeLine = i + 1
        } else if p.type == .img {
            besidePicture(i, min(at.offset, 1), dropped)
        } else {
            let cur = Doc.lineText(p, line), a = min(at.offset, cur.len)
            let ins = (a > 0 && !Rx(#"\s$"#).test(cur.slice(0, a)) ? " " : "") + dropped + (a < cur.len && !Rx(#"^\s"#).test(cur.slice(a)) ? " " : "")
            writeText(i, cur.slice(0, a) + ins + cur.slice(a), caret: CaretPlace(line: i, offset: a + ins.len))
            activeLine = i
        }
    }

    // MARK: paste and copy

    /// What a selection copies: the document's markdown, its HTML, and the document's own lines when whole conversations are in it.
    public func copy(_ sel: DocSelection) -> (markdown: String, html: String, own: String?)? {
        if sel.collapsed { return nil }
        let md = Doc.selectionMarkdown(lines, sel.start, sel.end)
        if md.isEmpty { return nil }
        return (md, Doc.selectionHtml(md), acrossSource(sel))
    }

    /// A paste of text (images are the view's: placeImage). `own`: the editor's own lines (a copy across whole
    /// conversations), taken as they are; `html`: the clipboard's HTML, whose links go back into a web page's plain text.
    public func paste(_ plain: String, html: String? = nil, own: String? = nil, at sel: DocSelection) {
        var s = sel
        let ls0 = lines
        // Over an answer: nothing, as typing there is nothing.
        if parsed(ls0)[min(s.anchor.line, ls0.count - 1)].type == .reply && lockedAt(ls0, s.anchor.line) { return }
        var t = (own ?? plain).replacingOccurrences(of: "\r", with: "")
        if t.isEmpty { return }
        if !s.sameLine { guard let at = deleteSelection(s) else { return }; s = DocSelection(line: at.line, offset: at.a) }
        let ls = lines, i = s.anchor.line
        guard i < ls.count, !lockedAt(ls, i) || (editing?.q == i) else { return }
        let p = parsed(ls)[i]
        var line = ls[i], cur = Doc.lineText(p, line)
        if p.type == .img && s.collapsed { besidePicture(i, s.anchor.offset, t); return }
        let inCode = Doc.isCode(p) || Doc.isFence(p)
        // Copied from a PDF (MATH-24): the page's layout comes out. Not in code.
        if own == nil && !inCode { t = PdfPaste.pdfText(t) }
        // Copied from a web page: the HTML gives the links' addresses back.
        if own == nil, !t.contains("]("), !inCode, let html, !html.isEmpty { t = Doc.withLinks(t, EditorCore.anchors(html)) }
        if p.type == .quote { t = Rx(#"^\n+|\n+$"#).replace(t, with: "") }
        var a = s.start.offset, b = s.end.offset
        // `>` typed with no space then a paste after it: the quote is written `> ` and what was pasted.
        if p.type == .quote && Rx(#"^>(?! )"#).test(line) && a >= 1 { line = "> " + line.slice(1); cur = line; a += 1; b += 1 }
        let parts = t.jsSplit("\n")
        if parts.count == 1 { writeText(i, cur.slice(0, a) + t + cur.slice(b), caret: CaretPlace(line: i, offset: a + t.len)); activeLine = i; return }
        // A question is one line: several lines pasted into an askable question line (or one starting one on an empty line) join.
        let asks = editing?.q == i || (p.type == .bart ? !lockedAt(ls, i) : p.type == .p && line.isEmpty && DocRx.BART.test(parts[0].trimStart))
        if asks { let flat = Doc.flattenPaste(t); writeText(i, cur.slice(0, a) + flat + cur.slice(b), caret: CaretPlace(line: i, offset: a + flat.len)); activeLine = i; return }
        if p.type == .quote {
            let lead = line.len - p.text.len, head = line.slice(0, max(a, lead)), tail = line.slice(max(b, lead))
            func row(_ x: String) -> String { x.isEmpty ? ">" : "> \(x)" }
            let end = parts.last! + tail
            setLines(CaretPlace(line: i + parts.count - 1, offset: row(end).len - tail.len)) { x in
                var out = x; out[i] = head + parts[0]; out.insert(contentsOf: parts.dropFirst().dropLast().map(row) + [row(end)], at: i + 1); return out
            }
            activeLine = i + parts.count - 1
            return
        }
        let first = cur.slice(0, a) + parts[0], last = parts.last! + cur.slice(b)
        func inAnswer(_ x: String) -> String { p.type == .reply ? Doc.sameLine(p, x) : x }
        setLines(CaretPlace(line: i + parts.count - 1, offset: parts.last!.len)) { x in
            var out = x; out[i] = Doc.sameLine(p, first); out.insert(contentsOf: parts.dropFirst().dropLast().map(inAnswer) + [inAnswer(last)], at: i + 1); return out
        }
        activeLine = i + parts.count - 1
    }

    /// The links of an HTML fragment, in order: (text, href).
    static func anchors(_ html: String) -> [(text: String, href: String)] {
        Rx(#"<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>"#, "i").matchAll(html).map { m in
            let href = Drop.decodeEntitiesPublic(m[1] ?? m[2] ?? m[3] ?? "")
            let inner = Drop.decodeEntitiesPublic(Rx(#"<[^>]*>"#).replace(m[4] ?? "", with: ""))
            return (inner, href)
        }
    }
}

extension Drop {
    /// HTML entities as their characters (drop.js decodeEntities), for the editor's paste of a page's links.
    public static func decodeEntitiesPublic(_ v: String) -> String {
        var s = Rx(#"&#(\d+);"#).replace(v) { m in Int(m[1]!).flatMap { Unicode.Scalar($0) }.map { String($0) } ?? m.str }
        s = Rx(#"&#x([0-9a-f]+);"#, "i").replace(s) { m in Int(m[1]!, radix: 16).flatMap { Unicode.Scalar($0) }.map { String($0) } ?? m.str }
        let ents = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": "\u{00A0}"]
        return Rx(#"&(amp|lt|gt|quot|apos|nbsp);"#).replace(s) { ents[$0[1]!]! }
    }
}
