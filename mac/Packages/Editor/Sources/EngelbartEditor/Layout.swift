import Foundation
import EngelbartDoc

// Where each line stands in a conversation (DocEditor.jsx layout(ls)): its role (title, question, answer, foot, pending,
// hidden), whether it opens or closes its card, and what is drawn after it (the reply field).

public struct LineAt: Equatable {
    public enum Role: String { case title, question, answer, foot, pending, hidden }
    public var threadFrom: Int
    public var titleLine: Int
    public var turnQ: Int
    public var role: Role
    public var agent: String
    /// Collapsed conversation (title row drawn, the rest hidden).
    public var collapsed = false
    public var running = false
    /// A question that opens its card (rounded top).
    public var top = false
    /// The line closes its card (rounded bottom, 8px under).
    public var closes = false
    /// The first line of an answer; the last line of its body.
    public var first = false
    public var lastBody = false
    /// The empty line the runner leaves before the closing line: not drawn.
    public var gap = false
    /// The question's turn is folded: drawn as one row.
    public var bare = false
    public var afterBare = false
    /// The turn is answered (a question asked), at work, a Build's.
    public var answered = false
    public var pending: String? = nil
    public var build: String? = nil
    public var foldedTurn = false
    /// A research box's line.
    public var box = false
    public var boxState: String? = nil
    /// Draw the conversation's reply field after this line.
    public var fieldAfter = false
    /// Draw a foot after this line (an answer with no closing line).
    public var footAfter = false
    /// The turn may be edited in place.
    public var editable = false
}

extension EditorCore {
    /// Each line's place in its conversation; lines in none have no entry.
    public func layout(canReply: Bool) -> [Int: LineAt] {
        let ls = lines, ps = parsed(ls)
        var at: [Int: LineAt] = [:]
        for thread in threads(ls) {
            let collapsed = isCollapsed(thread), running = isRunning(thread)
            let titleLine = thread.titleLine
            if titleLine >= 0 {
                var t = LineAt(threadFrom: thread.from, titleLine: titleLine, turnQ: thread.from, role: .title, agent: thread.agent)
                t.collapsed = collapsed; t.running = running
                at[titleLine] = t
            }
            if collapsed {
                for i in thread.from...thread.to {
                    var h = LineAt(threadFrom: thread.from, titleLine: titleLine, turnQ: thread.turns.first { i >= $0.q && i <= $0.to }?.q ?? thread.from, role: .hidden, agent: thread.agent)
                    h.collapsed = true
                    at[i] = h
                }
                continue
            }
            guard let end = thread.turns.last else { continue }
            let built = thread.to + 1 < ps.count && ps[thread.to + 1].type == .build
            let follow = end.answered && end.pending == nil && !end.folded && canReply && !built && end.build == nil
            let endBox = Doc.isResearch(ps[end.q]) ? boxState(ls, end) : nil
            let boxField = endBox != nil && !end.folded && !built && canReply && !readOnly
            let field = boxField || (follow && !readOnly)
            var afterBare = false
            for (n, turn) in thread.turns.enumerated() {
                let agent = turnAgent(thread, turn)
                let bare = turn.answered && turn.pending == nil && turn.folded
                let box = Doc.isResearch(ps[turn.q])
                let next = n + 1 < thread.turns.count ? thread.turns[n + 1] : nil
                let cut = next != nil && !Doc.isResearch(ps[next!.q]) && !next!.answered
                let nextBare = next != nil && next!.answered && next!.pending == nil && next!.folded && !Doc.isResearch(ps[next!.q])
                let footless = turn.answered && turn.pending == nil && turn.foot < 0
                let tail = n == thread.turns.count - 1
                let shuts = (tail && !field) || cut
                let state = box ? boxState(ls, turn) : nil
                var q = LineAt(threadFrom: thread.from, titleLine: titleLine, turnQ: turn.q, role: .question, agent: agent)
                q.top = turn.q == thread.from || box || !turn.answered
                q.afterBare = afterBare
                q.closes = !turn.answered || turn.build != nil || (bare && !box && shuts)
                q.bare = bare; q.answered = turn.answered; q.pending = turn.pending; q.build = turn.build; q.foldedTurn = turn.folded
                q.box = box; q.boxState = state; q.running = running
                q.editable = canEdit(ps[turn.q], turn) && !box
                _ = nextBare
                if tail && !turn.answered && field { q.fieldAfter = false }
                at[turn.q] = q
                afterBare = bare
                if turn.build != nil { continue }
                let gap = turn.foot > turn.from && Doc.parseLine(ls[turn.foot - 1]).text.isEmpty ? turn.foot - 1 : -1
                let lastBody = (turn.foot >= 0 ? turn.foot : turn.to + 1) - (gap >= 0 ? 2 : 1)
                if turn.from <= turn.to {
                    for i in turn.from...turn.to {
                        let role: LineAt.Role = i == turn.foot ? .foot : ps[i].type == .pending ? .pending : .answer
                        let ends = i == turn.to
                        var a = LineAt(threadFrom: thread.from, titleLine: titleLine, turnQ: turn.q, role: role, agent: agent)
                        a.gap = i == gap; a.first = i == turn.from; a.lastBody = i == lastBody
                        a.closes = ends && shuts && !footless
                        a.footAfter = ends && footless
                        a.fieldAfter = ends && tail && field
                        a.answered = turn.answered; a.pending = turn.pending; a.foldedTurn = turn.folded; a.box = box; a.boxState = state; a.running = running
                        at[i] = a
                    }
                }
            }
        }
        return at
    }
}
