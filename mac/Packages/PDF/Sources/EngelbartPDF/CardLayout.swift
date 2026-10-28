import Foundation

// Where the cards go (PaperView.jsx arrangePages, with the rounds of 2026-10-16 recorded there and in
// docs/superpowers/specs/2026-10-16-pdf-annotations-round.md). Pure: the cards' sizes come from `measure`, so the tests
// can hold it as test/paper-canvas-zoom.test.cjs holds PaperView's.
//
// A card is laid out in note px and drawn at its page's noteScale (round 3); in the sheet's px:
// - a highlight's card goes against the text's column at its highlight's height, as wide as the room between the text and
//   the pane's side (fitWidth, NOTE_MIN…NOTE_W); the other margin when its own is under NOTE_MIN and the other is not, or
//   when its own is full where it wants to be (stackNotes); then spaced (spaceBoxes) around the moved ones;
// - a moved or typed card (`pos`) starts where it was put; in the left margin it keeps to it, one against the text's right
//   edge goes into the right margin, elsewhere it narrows to FREE_FIT and is moved in;
// - a card whose margin shows less than HIDE_ROOM is hidden (round 4), never the one being typed in or dragged.

public enum CardLayout {
    public struct Spec: Equatable {
        public var id: String
        /// The mark's y (page units): a highlight's card wants to be at its height.
        public var markY: Double
        public var pos: PPoint?
        /// The highlight's side ('left' / 'right'); 'pos' for a moved or typed card.
        public var how: String
        /// The card typed from the selection's card, drawn where that card was (selCard).
        public var sel: Bool = false
        public var fixed: Bool
        /// Its width before the pane narrows it (cardWidth), note px.
        public var want: Double
        /// It keeps its whole width (a note being typed in, an empty one, one with answers): typingIn.
        public var typing: Bool
        public init(id: String, markY: Double, pos: PPoint?, how: String, sel: Bool = false, fixed: Bool, want: Double, typing: Bool) {
            self.id = id; self.markY = markY; self.pos = pos; self.how = how; self.sel = sel; self.fixed = fixed; self.want = want; self.typing = typing
        }
    }

    public struct Page {
        public var page: Int
        public var G: Double
        public var pageW: Double
        public var pageH: Double
        public var column: (l: Double, r: Double)?
        public var specs: [Spec]
        public init(page: Int, G: Double, pageW: Double, pageH: Double, column: (l: Double, r: Double)?, specs: [Spec]) {
            self.page = page; self.G = G; self.pageW = pageW; self.pageH = pageH; self.column = column; self.specs = specs
        }
    }

    /// A card being dragged: where the pointer has it (sheet px) and its width (note px).
    public struct Dragged: Equatable { public var id: String; public var left: Double; public var top: Double; public var w: Double
        public init(id: String, left: Double, top: Double, w: Double) { self.id = id; self.left = left; self.top = top; self.w = w }
    }

    public struct Place: Equatable {
        public var left: Double
        public var top: Double
        /// Its width as laid out (note px); `typing` cards are this wide, others as wide as their text up to it.
        public var w: Double
        /// On screen.
        public var width: Double
        public var height: Double
        public var hidden: Bool
        public var ns: Double
    }

    public struct View {
        /// The pane's sideways scroll and width: cards are kept within [x0 + EDGE_PAD, x0 + W − EDGE_PAD].
        public var x0: Double
        public var W: Double
        public init(x0: Double, W: Double) { self.x0 = x0; self.W = W }
    }

    /// Lays out the cards of `pages`. `measure(id, w)` is a card's size in note px laid out at width w (a typing card
    /// as wide as w, another as wide as its text up to w). `pageOver(page, y)`: the page under y px of page's sheet;
    /// `columnOf(page)` its column. `typedPlace(id, size)`: where the card typed from the selection's card goes (sheet px),
    /// nil when its selection does not show. `keepShown`: cards never hidden (typed in, with the keyboard).
    public static func arrange(_ pages: [Page], view: View, dragged: Dragged? = nil, keepShown: Set<String> = [],
                               measure: (String, Double) -> (width: Double, height: Double),
                               pageOver: (Int, Double) -> Int = { p, _ in p },
                               columnOf: (Int) -> (l: Double, r: Double)? = { _ in nil },
                               typedPlace: (String, Double, Double) -> (left: Double, top: Double)? = { _, _, _ in nil }) -> [String: Place] {
        let C = Canvas.self
        let vL = view.x0 + C.EDGE_PAD, vR = view.x0 + view.W - C.EDGE_PAD
        var out: [String: Place] = [:]

        struct Box { var s: Spec; var w: Double = 0; var left = 0.0; var top = 0.0; var ax = 0.0; var L = 0.0; var inLeft = false; var hide = false; var side = ""; var width = 0.0; var height = 0.0; var hidden = false }

        for p in pages {
            let ns = C.noteScale(p.pageW), span = (vR - vL) / ns
            let L = p.G + (p.column?.l ?? 0) * p.pageW, R = p.G + (p.column?.r ?? 1) * p.pageW
            let roomL = (L - C.SIDE_GAP - vL) / ns, roomR = (vR - R - C.SIDE_GAP) / ns
            var boxes: [Box] = []
            for s in p.specs {
                var b = Box(s: s)
                if let d = dragged, d.id == s.id {
                    b.w = d.w; b.left = d.left; b.top = d.top
                    boxes.append(b); continue
                }
                if s.sel { b.w = min(s.want, span) }
                else if s.fixed, let pos = s.pos {
                    let at = C.placeOf(pos, p.G, p.pageW)
                    b.ax = at.left; b.top = at.top
                    // The text it keeps clear of is the page it lies over: a note's `pos` can be past its page's foot.
                    let q = pageOver(p.page, b.top + C.POS_DY)
                    let cq = q == p.page ? p.column : columnOf(q)
                    let Lq = cq.map { p.G + $0.l * p.pageW } ?? (p.column.map { p.G + $0.l * p.pageW } ?? p.G)
                    let Rq = cq.map { p.G + $0.r * p.pageW } ?? (p.column.map { p.G + $0.r * p.pageW } ?? p.G + p.pageW)
                    b.L = Lq
                    b.inLeft = b.ax < Lq - C.SIDE_GAP
                    if !b.inLeft && b.ax < Rq + C.SIDE_GAP && b.ax + C.FREE_MIN * ns > Rq && (vR - Rq - C.SIDE_GAP) / ns >= C.FREE_MIN { b.ax = Rq + C.SIDE_GAP }
                    let from = max(b.ax, vL), room = ((b.inLeft ? Lq - C.SIDE_GAP : vR) - from) / ns
                    let inRight = b.ax >= Rq + C.SIDE_GAP - 0.5, rL = (Lq - C.SIDE_GAP - vL) / ns, rR = (vR - Rq - C.SIDE_GAP) / ns
                    let least = b.inLeft ? min(s.want, C.FREE_FIT, max(C.FREE_MIN, rL)) : inRight ? min(s.want, C.FREE_FIT, max(C.FREE_MIN, rR)) : min(s.want, C.FREE_FIT)
                    b.w = C.fitWidth(s.want, room, least, span)
                    b.hide = b.inLeft ? rL < C.HIDE_ROOM : inRight ? rR < C.HIDE_ROOM : b.ax < vL - 0.5 || b.ax > vR - C.FREE_MIN * ns
                } else {
                    let mine = s.how == "left" ? roomL : roomR, other = s.how == "left" ? roomR : roomL
                    b.side = mine < C.NOTE_MIN && other >= C.NOTE_MIN ? (s.how == "left" ? "right" : "left") : s.how
                    b.w = C.fitWidth(s.want, b.side == "left" ? roomL : roomR, C.NOTE_MIN, span)
                }
                boxes.append(b)
            }
            for i in boxes.indices {
                let m = measure(boxes[i].s.id, boxes[i].w)
                boxes[i].width = m.width * ns; boxes[i].height = m.height * ns
            }
            func show(_ i: Int, _ hide: Bool) { boxes[i].hidden = hide && !keepShown.contains(boxes[i].s.id) }
            // the card typed from the selection's card, where that card was; its selection out of the pane, beside it
            for i in boxes.indices where boxes[i].s.sel {
                if let at = typedPlace(boxes[i].s.id, boxes[i].width, boxes[i].height) { boxes[i].left = at.left; boxes[i].top = at.top; continue }
                let side = boxes[i].s.how == "left" ? "left" : "right"
                boxes[i].left = max(vL, min(side == "left" ? L - C.SIDE_GAP - boxes[i].width : R + C.SIDE_GAP, vR - boxes[i].width))
                boxes[i].top = max(0, boxes[i].s.markY * p.pageW - 6)
            }
            let fixedIdx = boxes.indices.filter { boxes[$0].s.fixed && !boxes[$0].s.sel }
            for i in fixedIdx {
                let isDragged = dragged?.id == boxes[i].s.id
                if !isDragged {
                    let b = boxes[i]
                    boxes[i].left = max(vL, min(b.inLeft ? min(b.ax, b.L - C.SIDE_GAP - b.width) : b.ax, vR - b.width))
                }
                show(i, !isDragged && boxes[i].hide)
            }
            let beside = boxes.indices.filter { !boxes[$0].s.fixed && !boxes[$0].s.sel }
            let narrow = min(roomL, roomR) < C.NOTE_MIN
            var want: [String: Double] = [:]
            for i in beside { want[boxes[i].s.id] = max(0, boxes[i].s.markY * p.pageW - 6) }
            let sides = Marks.stackNotes(beside.map { Marks.NoteItem(id: boxes[$0].s.id, ideal: want[boxes[$0].s.id]!, h: boxes[$0].height, side: boxes[$0].side) },
                                         gap: C.BOX_GAP, slack: narrow ? .infinity : Marks.NOTE_SLACK)
            for i in beside {
                let side = sides[boxes[i].s.id]?.side ?? boxes[i].side
                let room = side == "left" ? (L - C.SIDE_GAP - vL) / ns : (vR - R - C.SIDE_GAP) / ns
                let w = side == "left" ? L - C.SIDE_GAP - boxes[i].width : R + C.SIDE_GAP
                boxes[i].left = max(vL, min(w, vR - boxes[i].width))
                show(i, room < C.HIDE_ROOM)
            }
            let tops = Canvas.spaceBoxes(beside.filter { !boxes[$0].hidden }.map { i in
                Canvas.SpaceUnit(id: boxes[i].s.id, want: want[boxes[i].s.id]!, boxes: [.init(left: boxes[i].left, width: boxes[i].width, height: boxes[i].height)])
            }, fixed: fixedIdx.filter { !boxes[$0].hidden }.map { .init(left: boxes[$0].left, top: boxes[$0].top, width: boxes[$0].width, height: boxes[$0].height) })
            for i in beside { boxes[i].top = tops[boxes[i].s.id] ?? want[boxes[i].s.id]! }
            for b in boxes { out[b.s.id] = Place(left: b.left, top: b.top, w: b.w, width: b.width, height: b.height, hidden: b.hidden, ns: ns) }
        }
        return out
    }
}
