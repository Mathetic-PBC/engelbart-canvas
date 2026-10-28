import AppKit
import EngelbartDoc
import EngelbartUI

// DocEditor's behaviours around the text: a question just asked kept where it was on screen (keepAsked) and its reply
// field taking the keyboard once the answer lands (replyArrived); the space under a card (gapAt, openGap); a picture's
// corners and its drag to another place (startResize, startImgDrag, imgDropGaps).

/// What the editor holds for a question just asked (2026-10-16, David: "submitting a question must not move the
/// person's place in the document").
struct AskHold { var askId: String; var top: CGFloat; var until: Date; var seen = false }
struct ReplyWait { var askId: String; var at: Date; var line = -1 }

extension DocEditorView {
    static let ASK_HOLD: TimeInterval = 3

    // MARK: keeping the asked row in place

    /// The row being asked from (the caret's line, or the reply field typed in), its top in the pane now.
    func heldTop() -> CGFloat? {
        if pressing || Date().timeIntervalSince(wheelAt) < 0.4 { return nil }
        let paneTop = scroll.contentView.bounds.minY, paneH = scroll.contentSize.height
        var rowTop: CGFloat? = nil
        if let field = window?.firstResponder as? ReplyTextView, let box = field.superview { rowTop = textView.convert(box.bounds, from: box).minY }
        else if let line = core.activeLine, let r = paragraphRect(line) { rowTop = r.minY }
        guard let top = rowTop, top >= paneTop, top <= paneTop + paneH else { return nil }
        return top - paneTop
    }

    func asked(_ askId: String) {
        if let top = heldTop() { askHold = AskHold(askId: askId, top: top, until: Date().addingTimeInterval(DocEditorView.ASK_HOLD)) } else { askHold = nil }
        replyWait = ReplyWait(askId: askId, at: Date())
    }

    /// After a redraw: the question over pending line `askId` back where it was on screen; the hold ends once its pending
    /// line has been and gone, after 3 s, or when the person scrolls, clicks or types.
    func keepAsked() {
        guard var hold = askHold else { return }
        let ls = core.lines
        let at = ls.firstIndex(of: "bart~> \(hold.askId)") ?? -1
        if Date() > hold.until || (at < 1 && hold.seen) { askHold = nil; return }
        if at < 1 || pressing { return }
        hold.seen = true; askHold = hold
        guard let r = paragraphRect(at - 1) else { return }
        scrollTo(y: r.minY - hold.top)
    }

    /// The answer to a question just asked is in: its conversation's reply field takes the keyboard, when the person is
    /// still on that conversation (nothing typed since, the keyboard nowhere else) and the field is in sight.
    func replyArrived() {
        guard var wait = replyWait else { return }
        let ls = core.lines
        if let at = ls.firstIndex(of: "bart~> \(wait.askId)") { wait.line = at; replyWait = wait; return }
        replyWait = nil
        guard wait.line > 0, let found = core.findTurn(ls, wait.line - 1), found.turn.answered, found.turn.pending == nil, found.thread.turns.last == found.turn else { return }
        guard keyedAt <= wait.at else { return }
        let fr = window?.firstResponder
        let here = fr == nil || fr === window || fr === textView && (core.activeLine.map { $0 >= found.thread.from && $0 <= found.thread.to } ?? true) || (fr as? ReplyTextView).map { ($0.superview as? ReplyFieldView)?.from == found.thread.from } == true
        guard here, let field = overlays.compactMap({ $0 as? ReplyFieldView }).first(where: { $0.from == found.thread.from }) else { return }
        let r = textView.convert(field.bounds, from: field), pane = scroll.contentView.bounds
        if r.minY >= pane.minY && r.maxY <= pane.maxY || wheelAt <= wait.at { window?.makeFirstResponder(field.field) }
    }

    // MARK: the space under a card

    /// The last line of each card (cardEnds): a conversation's, a Build's, a run's, a code block's, a checklist's.
    func cardEnds() -> Set<Int> {
        let ls = core.lines, ps = core.parsed(ls)
        var ends = Set<Int>()
        var j = 0
        while j < ls.count {
            let p = ps[j]
            if p.type == .build || p.type == .pending { ends.insert(j) }
            else if (p.type == .fence) && !p.open { ends.insert(j) }
            else if p.type == .todo { var k = j; while k + 1 < ls.count && ps[k + 1].type == .todo { k += 1 }; ends.insert(k); j = k }
            j += 1
        }
        for t in core.threads(ls) where t.to > t.from || t.titleLine >= 0 { ends.insert(t.to) }
        return ends
    }

    /// A press in the space under a card, or in the room a heading right under one has above its text → (line, add).
    func gapAt(_ point: NSPoint) -> (at: Int, add: Bool)? {
        guard !readOnly else { return nil }
        let ls = core.lines, ps = core.parsed(ls), ends = cardEnds()
        for (i, m) in rendered.maps.enumerated() {
            guard let r = paragraphRect(i), r.height > 0.5, point.y >= r.minY, point.y < r.maxY else { continue }
            let style = (m.range.location < (textView.textStorage?.length ?? 0) ? textView.textStorage?.attribute(.paragraphStyle, at: m.range.location, effectiveRange: nil) : nil) as? NSParagraphStyle
            var at = -1
            if ends.contains(i), i + 1 < ls.count, point.y >= r.maxY - max(8, style?.paragraphSpacing ?? 0) + (style?.paragraphSpacing ?? 0) - 8 { at = i + 1 }
            else if i > 0, ends.contains(i - 1), ps[i].type == .h, point.y < r.minY + (style?.paragraphSpacingBefore ?? 0) { at = i }
            guard at >= 0, at < ls.count else { return nil }
            return (at, !(ls[at].isEmpty && ps[at].type == .p))
        }
        return nil
    }

    // MARK: pictures: corners and drag

    /// The picture's rect on line `i` in the text view.
    func pictureRect(_ i: Int) -> NSRect? {
        guard i < rendered.maps.count else { return nil }
        let m = rendered.maps[i]
        guard m.range.length > 0, textView.textStorage?.attribute(.attachment, at: m.range.location, effectiveRange: nil) != nil else { return nil }
        let g = layoutManager.glyphRange(forCharacterRange: NSRange(location: m.range.location, length: 1), actualCharacterRange: nil)
        return layoutManager.boundingRect(forGlyphRange: g, in: textView.textContainer!).offsetBy(dx: textView.textContainerOrigin.x, dy: textView.textContainerOrigin.y)
    }

    func placePictureHandles() {
        guard !readOnly else { return }
        for (i, line) in core.lines.enumerated() where core.parsed()[i].type == .img {
            guard let r = pictureRect(i) else { continue }
            let h = PictureHandles(line: i, editor: self)
            h.frame = r
            textView.addSubview(h); overlays.append(h)
            _ = line
        }
    }
}

/// A picture's four corners (unseen 16px squares with resize cursors) and its body (a drag moves the line, a click
/// opens the viewer).
final class PictureHandles: NSView {
    let line: Int
    weak var editor: DocEditorView?
    static let corner: CGFloat = 16
    init(line: Int, editor: DocEditorView) { self.line = line; self.editor = editor; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    func corners() -> [(String, NSRect)] {
        let c = PictureHandles.corner
        return [("nw", NSRect(x: 0, y: 0, width: c, height: c)), ("ne", NSRect(x: bounds.width - c, y: 0, width: c, height: c)),
                ("sw", NSRect(x: 0, y: bounds.height - c, width: c, height: c)), ("se", NSRect(x: bounds.width - c, y: bounds.height - c, width: c, height: c))]
    }
    static func resizeCursor(_ side: String) -> NSCursor {
        if #available(macOS 15.0, *) {
            switch side { case "nw": return .frameResize(position: .topLeft, directions: .all); case "ne": return .frameResize(position: .topRight, directions: .all)
            case "sw": return .frameResize(position: .bottomLeft, directions: .all); default: return .frameResize(position: .bottomRight, directions: .all) }
        }
        return .crosshair
    }
    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .openHand)
        for (side, r) in corners() { addCursorRect(r, cursor: PictureHandles.resizeCursor(side)) }
    }
    override func mouseDown(with event: NSEvent) {
        guard let editor, let window else { return }
        let p0 = convert(event.locationInWindow, from: nil)
        if let (side, _) = corners().first(where: { $0.1.contains(p0) }) { resize(side, from: event, in: window, editor: editor); return }
        drag(from: event, in: window, editor: editor)
    }

    /// A corner dragged sizes the picture live (an outline); let go, its width goes into its line (`|w=`), 48…column.
    func resize(_ side: String, from event: NSEvent, in window: NSWindow, editor: DocEditorView) {
        let dir: CGFloat = side.hasSuffix("w") ? -1 : 1
        let x0 = event.locationInWindow.x, w0 = bounds.width
        let maxW = editor.textView.textContainer?.size.width ?? 2000
        var w = w0.rounded()
        let outline = OutlineView(frame: frame)
        superview?.addSubview(outline)
        while let e = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            w = max(48, min(maxW, (w0 + dir * (e.locationInWindow.x - x0)).rounded()))
            let h = frame.height * w / max(1, w0)
            outline.frame = NSRect(x: dir < 0 ? frame.maxX - w : frame.minX, y: frame.minY, width: w, height: h)
            if e.type == .leftMouseUp { break }
        }
        outline.removeFromSuperview()
        editor.core.resizeImage(line, width: Int(w))
        editor.redraw(keepSelection: true)
    }

    /// The picture dragged: after 5px a copy at most 220×160 follows the pointer, the picture turns light grey where it
    /// was, a 2px #c9c9c9 line with a ring at its start shows where it lands (the nearest allowed gap); the pane scrolls
    /// near its edges; Escape or nowhere allowed leaves it. A press that does not move opens the viewer.
    func drag(from event: NSEvent, in window: NSWindow, editor: DocEditorView) {
        let start = event.locationInWindow
        var moved = false, target: Int? = nil
        let gaps = EditorCore.imgDropGaps(editor.core.lines)
        let k = min(1, 220 / max(1, bounds.width), 160 / max(1, bounds.height))
        var ghost: NSImageView? = nil, bar: DropBar? = nil, grey: NSView? = nil
        let image = (editor.textView.textStorage?.attribute(.attachment, at: editor.rendered.maps[line].range.location, effectiveRange: nil) as? NSTextAttachment)?.image
        func finish(_ drop: Bool) {
            ghost?.removeFromSuperview(); bar?.removeFromSuperview(); grey?.removeFromSuperview()
            if drop, let j = target { editor.core.moveImage(line, before: j); editor.redraw() }
        }
        while let e = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp, .keyDown]) {
            if e.type == .keyDown { if e.keyCode == 53 { finish(false); return }; continue }
            if e.type == .leftMouseUp { if moved { finish(true) } else if let image { ImageViewer.show(image, over: window) }; return }
            let p = e.locationInWindow
            if !moved {
                if abs(p.x - start.x) + abs(p.y - start.y) < 5 { continue }
                moved = true
                let g = NSImageView(frame: NSRect(x: 0, y: 0, width: bounds.width * k, height: bounds.height * k))
                g.image = image; g.imageScaling = .scaleProportionallyUpOrDown; g.wantsLayer = true
                g.layer?.cornerRadius = 8; g.layer?.masksToBounds = true; g.layer?.borderColor = NSColor(white: 0, alpha: 0.06).cgColor; g.layer?.borderWidth = 1
                editor.addSubview(g); ghost = g
                let b = DropBar(); editor.textView.addSubview(b); bar = b
                let gr = NSView(frame: frame); gr.wantsLayer = true; gr.layer?.backgroundColor = NSColor(hex: "#ededed").cgColor
                superview?.addSubview(gr); grey = gr
            }
            let inEditor = editor.convert(p, from: nil)
            ghost?.frame.origin = NSPoint(x: inEditor.x - (convert(start, from: nil).x) * k, y: inEditor.y - (convert(start, from: nil).y) * k)
            let inText = editor.textView.convert(p, from: nil)
            var best: (j: Int, y: CGFloat)? = nil
            for j in gaps.sorted() {
                let y: CGFloat
                if j < editor.rendered.maps.count, let r = editor.paragraphRect(j), r.height > 0.5 { y = r.minY }
                else if j == editor.rendered.maps.count, let r = editor.paragraphRect(j - 1) { y = r.maxY } else { continue }
                if best == nil || abs(y - inText.y) < abs(best!.y - inText.y) { best = (j, y) }
            }
            target = best.flatMap { $0.j != line && $0.j != line + 1 ? $0.j : nil }
            if let best, target != nil {
                bar?.isHidden = false
                bar?.frame = NSRect(x: editor.textView.textContainerOrigin.x - 7, y: best.y - 4, width: (editor.textView.textContainer?.size.width ?? 600) + 7, height: 8)
            } else { bar?.isHidden = true }
            // Near the pane's top or bottom edge, the pane scrolls.
            let pane = editor.scroll.convert(p, from: nil)
            if pane.y < 40 { editor.scrollTo(y: editor.scroll.contentView.bounds.minY - 14) }
            else if pane.y > editor.scroll.bounds.height - 40 { editor.scrollTo(y: editor.scroll.contentView.bounds.minY + 14) }
        }
    }
}

final class OutlineView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        let p = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 8, yRadius: 8)
        p.setLineDash([4, 3], count: 2, phase: 0); p.lineWidth = 1.5; NSColor(hex: "#c9c9c9").setStroke(); p.stroke()
    }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// Where a dragged picture lands: a 2px light grey line, a ring at its start.
final class DropBar: NSView {
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        let c = NSColor(hex: "#c9c9c9")
        c.setFill(); NSBezierPath(roundedRect: NSRect(x: 7, y: 3, width: bounds.width - 7, height: 2), xRadius: 1, yRadius: 1).fill()
        let ring = NSBezierPath(ovalIn: NSRect(x: 1, y: 1, width: 6, height: 6))
        NSColor.white.setFill(); ring.fill(); ring.lineWidth = 2; c.setStroke(); ring.stroke()
    }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
