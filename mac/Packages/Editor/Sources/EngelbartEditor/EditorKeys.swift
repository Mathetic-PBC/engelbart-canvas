import Foundation
import EngelbartDoc

// editorKey (DocEditor.jsx:3453): what a key does to the document. The @ menu's keys are the view's (MentionController),
// handled before these. → whether the key was used (the view then does nothing else with it).

extension EditorCore {
    static let NOTE_VERB = Rx(#"(^|\s)@Note(?:\s+(.*))?$"#)

    /// The mention token of `text` that ends at `at` (`before`) or starts there → [start, end).
    static func mentionBeside(_ text: String, _ at: Int, before: Bool) -> (Int, Int)? {
        var acc = 0
        for tok in Inline.INLINE.split(text) {
            let end = acc + tok.len
            if tok.hasPrefix("@[") && (before ? end == at : acc == at) { return (acc, end) }
            acc = end
        }
        return nil
    }

    @discardableResult
    public func key(_ e: KeyPress, sel: DocSelection) -> Bool {
        if armed != nil && e.key != "Backspace" && e.key != "Delete" && !["Shift", "Meta", "Control", "Alt"].contains(e.key) { disarm() }
        let ls = lines, ps = parsed(ls)
        let i = sel.anchor.line
        guard i >= 0 && i < ls.count else { return false }
        let line = ls[i], p = ps[i], cur = Doc.lineText(p, line), mod = e.cmd
        let same = sel.sameLine, a = sel.start.offset, b = sel.end.offset, collapsed = sel.collapsed
        let k = e.key.lowercased()
        if mod && k == "z" { if e.shift { redo() } else { undo() }; return true }
        if readOnly { return false }
        // The question being edited (2026-10-03): Enter asks it again, Shift+Enter adds no line, Escape puts it back, and it
        // is never joined to the line above or below it.
        if let ed = editing, same, i == ed.q {
            if e.key == "Enter" { if e.composing { return false }; if !e.shift && !mod { commitEdit() }; return true }
            if e.key == "Escape" { cancelEdit(); return true }
            if (e.key == "Backspace" && collapsed && a == 0) || (e.key == "Delete" && collapsed && a == cur.len) { return true }
        }
        if lockedAt(ls, i) && !(e.key == "Backspace" || e.key == "Delete" || e.key == "Escape") { return ["Enter", "Tab"].contains(e.key) }
        if mod && same && k == "b" { wrap(i, cur, a, b, "**"); return true }
        if mod && same && k == "i" { wrap(i, cur, a, b, "*"); return true }
        if mod && same && k == "k" { link(i, cur, a, b); return true }
        if mod && e.key == "Enter" { return true }
        if e.key == "Tab" {
            if Doc.isMarked(p.type) { indent(i, e.shift ? -1 : 1); caret = CaretPlace(line: i, offset: a) }
            else if Doc.isCode(p) && same { indentCode(i, cur, a, b, out: e.shift) }
            return true
        }
        // `@Note name` + Enter: a note by that name is made and the words become its mention.
        if e.key == "Enter" && !e.shift && !mod && hooks.noteVerb != nil && EditorCore.NOTE_VERB.test(cur) { noteVerb(i); return true }
        if e.key == "Enter" && !e.shift && !mod && p.type == .bart { askInline(i); return true }
        if e.key == "Enter" && !e.shift && !mod {
            if e.composing { return false }
            if !same { return true }
            // A fence typed on a line of its own, with nothing below to close it: Enter closes it and the caret goes inside.
            if p.type == .p && a == cur.len, let fence = DocRx.FENCE.match(line) {
                setLines(CaretPlace(line: i + 1, offset: 0)) { x in var out = x; out.insert(contentsOf: ["", (fence[1] ?? "") + fence[2]!], at: i + 1); return out }
                activeLine = i + 1; return true
            }
            // In code the new line starts at the indent of the one it came from, one step deeper after an opening bracket.
            if Doc.isCode(p) {
                let head = cur.slice(0, a)
                var lead = Rx(#"^[ \t]*"#).match(head)?.str ?? ""
                if Rx(#"[\[{(]\s*$"#).test(head) { lead += "  " }
                setLines(CaretPlace(line: i + 1, offset: lead.len)) { x in var out = x; out[i] = Doc.sameLine(p, head); out.insert(Doc.sameLine(p, lead + cur.slice(b)), at: i + 1); return out }
                activeLine = i + 1; return true
            }
            if Doc.isMarked(p.type) && p.text.trimmed.isEmpty {
                if p.depth > 0 { indent(i, -1); caret = CaretPlace(line: i, offset: 0) }
                else { setLines(CaretPlace(line: i, offset: 0)) { x in x.enumerated().map { $0.offset == i ? "" : $0.element } } }
                return true
            }
            let head = cur.slice(0, a), tail = cur.slice(b)
            let l1 = Doc.sameLine(p, head)
            var next = p; if let n = p.num { next.num = n + 1 }
            let l2 = p.type == .todo ? Doc.todoLine(p.depth, false, tail) : Doc.sameLine(next, tail)
            setLines(CaretPlace(line: i + 1, offset: 0)) { x in var out = x; out[i] = l1; out.insert(l2, at: i + 1); return out }
            activeLine = i + 1
            return true
        }
        // Beside a picture alone on its line (2026-10-15, David).
        if p.type == .img && collapsed && !mod && !e.alt && !e.composing {
            let after = a > 0, kk = after ? i + 1 : i - 1
            if (e.key == "Backspace" && after) || (e.key == "Delete" && !after) { writeText(i, "", caret: CaretPlace(line: i, offset: 0)); activeLine = i; return true }
            if e.key == "Backspace" || e.key == "Delete" {
                guard kk >= 0 && kk < ls.count else { return true }
                let near = ls[kk]
                if near.isEmpty && !lockedAt(ls, kk) {
                    let to = after ? i : i - 1
                    setLines(CaretPlace(line: to, offset: after ? line.len : 0)) { x in x.enumerated().filter { $0.offset != kk }.map { $0.element } }
                    activeLine = to; return true
                }
                if lockedAt(ls, kk) { return true }
                caret = CaretPlace(line: kk, offset: after ? 0 : Doc.lineText(ps[kk], near).len); activeLine = kk
                return true
            }
            if e.key.count == 1 { besidePicture(i, a, e.key); return true }
        }
        // Backspace right after a mention, or Delete right before one, takes the whole token (MATH-57). ⌥ and ⌘ do not.
        if (e.key == "Backspace" || e.key == "Delete") && collapsed && !mod && !e.alt && !Doc.isCode(p) && !Doc.isFence(p) {
            if let span = EditorCore.mentionBeside(cur, a, before: e.key == "Backspace") {
                writeText(i, cur.slice(0, span.0) + cur.slice(span.1), caret: CaretPlace(line: i, offset: span.0)); activeLine = i; return true
            }
        }
        if (e.key == "Backspace" || e.key == "Delete") && !same { deleteSelection(sel); return true }
        // Backspace at the start of a quote's text takes its `> ` off.
        if e.key == "Backspace" && collapsed && !mod && p.type == .quote && a > 0 && a == line.len - p.text.len {
            setLines(CaretPlace(line: i, offset: 0)) { x in x.enumerated().map { $0.offset == i ? p.text : $0.element } }
            activeLine = i; return true
        }
        if e.key == "Backspace" && collapsed && a == 0 {
            if lockedAt(ls, i) { return true }
            if Doc.isMarked(p.type) {
                if p.depth > 0 { indent(i, -1); caret = CaretPlace(line: i, offset: 0) }
                else { setLines(CaretPlace(line: i, offset: 0)) { x in x.enumerated().map { $0.offset == i ? p.text : $0.element } } }
                return true
            }
            guard i > 0 else { return true }
            let q = ps[i - 1]
            // A fence is not merged into the line next to it: the caret steps over it.
            if (Doc.isFence(p) || Doc.isFence(q)) && !cur.isEmpty && !Doc.lineText(q, ls[i - 1]).isEmpty {
                caret = CaretPlace(line: i - 1, offset: Doc.lineText(q, ls[i - 1]).len); activeLine = i - 1; return true
            }
            // A conversation over the line: marked, then taken away. An empty line goes first, when a line follows it.
            if !mod, let block = blockAt(ls, end: i - 1) {
                if armedIs(block) { dropBlock(block, caret: CaretPlace(line: block.from, offset: 0)); return true }
                armed = (block.from, block.to, block.thread.from)
                if cur.isEmpty && i + 1 < ls.count {
                    setLines(CaretPlace(line: i, offset: 0)) { x in x.enumerated().filter { $0.offset != i }.map { $0.element } }
                    activeLine = i
                }
                return true
            }
            if lockedAt(ls, i - 1) {
                // Answers are read-only: an empty line right after one goes away; a line with text stays.
                if !cur.isEmpty || ls.count < 2 { return true }
                var kk = i - 1
                while kk >= 0 && lockedAt(ls, kk) { kk -= 1 }
                let target = kk >= 0 ? CaretPlace(line: kk, offset: Doc.lineText(Doc.parseLine(ls[kk]), ls[kk]).len) : nil
                setLines(target) { x in x.enumerated().filter { $0.offset != i }.map { $0.element } }
                activeLine = kk >= 0 ? kk : nil
                return true
            }
            let off = Doc.lineText(q, ls[i - 1]).len
            setLines(CaretPlace(line: i - 1, offset: off)) { x in
                var out = x; out[i - 1] = Doc.sameLine(q, Doc.lineText(q, x[i - 1]) + cur); out.remove(at: i); return out
            }
            activeLine = i - 1
            return true
        }
        if e.key == "Delete" && collapsed && a == cur.len && i < ls.count - 1 {
            if lockedAt(ls, i) { return true }
            let q = ps[i + 1]
            if !mod, let block = blockAt(ls, start: i + 1) {
                if armedIs(block) { dropBlock(block, caret: CaretPlace(line: i, offset: a)) } else { armed = (block.from, block.to, block.thread.from) }
                return true
            }
            if lockedAt(ls, i + 1) { return true }
            let nt = Doc.lineText(q, ls[i + 1])
            if (Doc.isFence(p) || Doc.isFence(q)) && !cur.isEmpty && !nt.isEmpty { return true }
            setLines(CaretPlace(line: i, offset: cur.len)) { x in var out = x; out[i] = Doc.sameLine(p, cur + nt); out.remove(at: i + 1); return out }
            return true
        }
        if (e.key == "Backspace" || e.key == "Delete") && lockedAt(ls, i) { return true }
        // Escape takes the caret out of the line, and that is all it does.
        if e.key == "Escape" { activeLine = nil; return true }
        return false
    }

    /// Enter on a line holding `@Note name`: the note is made, and the words become its mention if the line still holds them.
    func noteVerb(_ i: Int) {
        let ls = lines, cur = lineText(ls, i)
        guard let m = EditorCore.NOTE_VERB.match(cur), let make = hooks.noteVerb else { return }
        let said = cur.slice(m.index + (m[1] ?? "").len)
        let name = Rx(#"[\[\]]"#).replace(m[2] ?? "", with: "").trimmed
        make(name) { [weak self] made in
            guard let self, let made else { return }
            let now = self.lines
            guard i < now.count else { return }
            let t = self.lineText(now, i), at = t.lastIndexOf(said)
            if at < 0 { return }
            let next = t.slice(0, at) + "@[\(made)] "
            self.writeText(i, next, caret: CaretPlace(line: i, offset: next.len))
            self.activeLine = i
        }
    }
}
