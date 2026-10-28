import AppKit
import EngelbartDoc
import EngelbartUI

// A mentioned workspace's peek inside the editor (WorkspacePeek.jsx, 2026-09-25): hovering `@[Name](ws:<id>)` shows
// "PROJECT · <above>", its name, Bart waiting or working there, the last 8 lines of its document (ui/DocPreview.jsx
// tail, 12.5px) and "Edited … ago · Click to go there". 360 wide. The data is the host's (workspacePeek,
// workspacePeekText); the text is read once per hover.

enum DocPreview {
    static func hidden(_ p: ParsedLine) -> Bool {
        p.type == .pending || p.type == .img || p.type == .fence || p.code == .open || p.code == .close || (p.type == .p && p.text.trimmed.isEmpty)
    }
    /// Where the last `n` lines that show something begin.
    static func tailStart(_ ps: [ParsedLine], _ n: Int) -> Int {
        var left = n
        for i in stride(from: ps.count - 1, through: 0, by: -1) where !hidden(ps[i]) { left -= 1; if left == 0 { return i } }
        return 0
    }
    /// A document read-only: headings bold, tasks and bullets as dashes (done ✓, struck), numbered rows by their number,
    /// answers and quotes grey, code in mono; inline marks drawn as the page draws them (their shown text).
    static func text(_ text: String, tail: Int? = nil, size: CGFloat = 10.5) -> NSAttributedString {
        let lines = Rx(#"^\s*\n"#).replace(text, with: "", global: false).components(separatedBy: "\n")
        let ps = Doc.parseLines(lines)
        let from = tail.map { tailStart(ps, $0) } ?? 0
        let out = NSMutableAttributedString()
        let para = NSMutableParagraphStyle(); para.minimumLineHeight = (size * 1.45).rounded(); para.maximumLineHeight = para.minimumLineHeight
        func add(_ s: String, font: NSFont = Fonts.sans(size), color: NSColor = Look.ink, head: CGFloat = 0, strike: Bool = false) {
            let p = para.mutableCopy() as! NSMutableParagraphStyle; p.headIndent = head; p.firstLineHeadIndent = head
            var a: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: p]
            if strike { a[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if out.length > 0 { out.append(NSAttributedString(string: "\n", attributes: a)) }
            out.append(NSAttributedString(string: s, attributes: a))
        }
        func shown(_ t: String) -> String { Inline.tokens(t).map { Inline.tokShown($0).shown }.joined() }
        for i in from..<lines.count {
            let p = ps[i]
            if p.type == .pending || p.type == .img || p.type == .fence || p.code == .open || p.code == .close { continue }
            if p.code == .body { add(p.text.isEmpty ? "\u{00A0}" : p.text, font: Fonts.mono(size * 0.92), color: Look.mid, head: size * 0.7); continue }
            if p.type == .code { add(lines[i].isEmpty ? "\u{00A0}" : lines[i], font: Fonts.mono(size * 0.92)); continue }
            if p.type == .p && p.text.trimmed.isEmpty { add("", font: Fonts.sans(size * 0.6)); continue }
            let body = shown(p.type == .bart ? "@\(Doc.tokenOf(Doc.agentOf(p))) \(p.text)" : p.text)
            switch p.type {
            case .h: add(body, font: Fonts.sans(size, weight: 600))
            case .todo, .list:
                let done = p.type == .todo && p.done
                let mark = done ? "✓" : p.type == .list && p.num != nil ? Doc.listMark(p) : "–"
                add("\(mark) \(body)", color: done ? Look.grey : Look.ink, head: size * (0.6 + CGFloat(p.depth) * 0.9), strike: done)
            case .reply, .quote: add(body, color: Look.mid, head: size * 0.7)
            default: add(body)
            }
        }
        return out
    }
}

/// "now", "5 min", "3 h", "2 d" since an ISO time (model/nav.js ago); "" when it does not read.
func agoText(_ iso: String?, now: Date = Date()) -> String {
    guard let iso else { return "" }
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let then = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
    let minutes = Int(max(0, now.timeIntervalSince(then)) / 60)
    if minutes < 1 { return "now" }
    if minutes < 60 { return "\(minutes) min" }
    if minutes < 60 * 24 { return "\(minutes / 60) h" }
    return "\(minutes / (60 * 24)) d"
}

final class WorkspacePeekView: FlippedView {
    let id: String, name: String
    let info: WorkspacePeekInfo?
    let text: String?
    static let width: CGFloat = 360
    static let TAIL = 8
    init(id: String, name: String, info: WorkspacePeekInfo?, text: String?) {
        self.id = id; self.name = name; self.info = info; self.text = text
        super.init(frame: .zero)
        setAccessibilityRole(.group); setAccessibilityLabel(info?.name ?? name)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    var eyebrow: String { (info?.above.isEmpty ?? true) ? "PROJECT" : "PROJECT · \(info!.above.joined(separator: " / ").uppercased())" }
    var bartLine: String? { info?.bart.map { $0 == "waiting" ? "Bart answered — waiting for you" : "Bart is working here" } }
    var footLine: String {
        let edited = agoText(info?.editedAt)
        return (edited.isEmpty ? "" : "Edited \(edited == "now" ? "just now" : "\(edited) ago") · ") + "Click to go there"
    }
    var preview: NSAttributedString? {
        guard info != nil else { return nil }
        guard let text else { return nil }
        if text.trimmed.isEmpty { return NSAttributedString(string: "Nothing written yet.", attributes: [.font: Fonts.sans(12.5), .foregroundColor: Look.grey]) }
        return DocPreview.text(text, tail: WorkspacePeekView.TAIL, size: 12.5)
    }
    let inner = WorkspacePeekView.width - 32
    func nameHeight() -> CGFloat { CardText.height(NSAttributedString(string: info?.name ?? name, attributes: [.font: Fonts.sans(14.5, weight: 500)]), width: inner) }
    var wanted: CGSize {
        var h: CGFloat = 14 + 10 + 8 + nameHeight()
        if info == nil { h += 6 + 20 }
        if bartLine != nil { h += 6 + 19 }
        if info != nil { h += 10 + 1 + 10 + (preview.map { CardText.height($0, width: inner) } ?? 18) }
        if info != nil { h += 10 + 1 + 10 + 18 }
        return CGSize(width: WorkspacePeekView.width, height: h + 14)
    }
    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
        NSColor.white.setFill(); path.fill(); NSColor(hex: "#c9c9c9").setStroke(); path.lineWidth = 1; path.stroke()
        var y: CGFloat = 14
        (eyebrow as NSString).draw(with: NSRect(x: 16, y: y, width: inner, height: 12), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: [.font: Fonts.sans(9, weight: 500), .foregroundColor: Look.grey, .kern: 1.6])
        y += 10 + 8
        let nh = nameHeight()
        ((info?.name ?? name) as NSString).draw(with: NSRect(x: 16, y: y, width: inner, height: nh), options: .usesLineFragmentOrigin, attributes: [.font: Fonts.sans(14.5, weight: 500), .foregroundColor: Look.ink])
        y += nh
        guard info != nil else {
            ("This workspace is gone." as NSString).draw(at: NSPoint(x: 16, y: y + 6), withAttributes: [.font: Fonts.sans(12.5), .foregroundColor: Look.grey])
            return
        }
        if let b = bartLine {
            y += 6
            let waiting = info?.bart == "waiting"
            let dot = NSRect(x: 16, y: y + 6, width: 7, height: 7)
            if waiting { Look.blue.setFill(); NSBezierPath(ovalIn: dot).fill() }
            else { let d = NSBezierPath(ovalIn: dot.insetBy(dx: 0.75, dy: 0.75)); d.setLineDash([2, 1.5], count: 2, phase: 0); d.lineWidth = 1.5; Look.grey.setStroke(); d.stroke() }
            (b as NSString).draw(at: NSPoint(x: 30, y: y), withAttributes: [.font: Fonts.sans(12.5), .foregroundColor: waiting ? Look.blue : Look.mid])
            y += 19
        }
        y += 10
        NSColor(hex: "#eaeaea").setFill(); NSRect(x: 16, y: y, width: inner, height: 1).fill()
        y += 1 + 10
        if let pv = preview { let h = CardText.height(pv, width: inner); pv.draw(with: NSRect(x: 16, y: y, width: inner, height: h), options: [.usesLineFragmentOrigin, .usesFontLeading]); y += h }
        else { y += 18 }
        y += 10
        NSColor(hex: "#eaeaea").setFill(); NSRect(x: 16, y: y, width: inner, height: 1).fill()
        y += 1 + 10
        (footLine as NSString).draw(at: NSPoint(x: 16, y: y), withAttributes: [.font: Fonts.sans(12), .foregroundColor: Look.grey])
    }
}

extension DocEditorView {
    /// The pointer on a workspace's mention: its peek under it, the document read once.
    func peekWorkspace(_ id: String, name: String, anchor: NSRect) {
        if let p = wsPeek, p.id == id, p.superview != nil { return }
        closePop()
        let info = host?.docEditor(self, workspacePeek: id)
        let v = WorkspacePeekView(id: id, name: name, info: info, text: wsPeekText[id])
        place(v, anchor: anchor)
        wsPeek = v
        if info != nil && wsPeekText[id] == nil {
            host?.docEditor(self, workspacePeekText: id) { [weak self] text in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.wsPeekText[id] = text ?? ""
                    if let p = self.wsPeek, p.id == id, p.superview != nil {
                        let again = WorkspacePeekView(id: id, name: name, info: info, text: text ?? "")
                        self.place(again, anchor: anchor); p.removeFromSuperview(); self.wsPeek = again
                    }
                }
            }
        }
    }
    func place(_ v: WorkspacePeekView, anchor: NSRect) {
        let size = v.wanted
        let spot = Placement.place(PlaceAnchor(convert(anchor, from: textView)), size: size, view: bounds.size, gap: 8, margin: 8)
        v.frame = NSRect(x: spot.left, y: spot.top, width: size.width, height: min(440, spot.maxHeight ?? size.height))
        addSubview(v)
    }
    func closeWorkspacePeek() { wsPeek?.removeFromSuperview(); wsPeek = nil; wsPeekText = [:] }
}
