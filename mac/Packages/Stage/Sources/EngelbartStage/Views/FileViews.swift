import AppKit
import EngelbartCore
import EngelbartUI

// A file drawn on the Stage (Stage.jsx MarkdownView, TableView, the text and the picture): markdown from its blocks (never
// read as html), a csv or tsv as a table (2000 rows shown), other text as it is, a picture as itself. Find in one: its
// text's matches tinted and the one in front scrolled to (Stage.jsx textRanges/paintRanges: CSS highlights there,
// temporary attributes here); a passage of three words or more that no one stretch holds is matched as a citation is
// (passage-text.cjs matchPassage). A link in a markdown file opens on the Stage.

@MainActor
protocol StageFileView: AnyObject {
    var view: NSView { get }
    /// A new query starts over (step 0), else steps → (matches, active); '' clears.
    func find(_ text: String, step: Int) -> (matches: Int, active: Int)
    func clearFind()
}

/// A text the Stage draws (markdown or plain), searchable.
final class TextFileView: NSObject, StageFileView, NSTextViewDelegate {
    let scroll = NSScrollView()
    let text = NSTextView()
    var view: NSView { scroll }
    var onLink: ((String) -> Void)?
    private var ranges: [NSRange] = []
    private var active = -1
    private var query = ""

    init(attributed: NSAttributedString, inset: NSSize, maxWidth: CGFloat?) {
        self.maxWidth = maxWidth
        super.init()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = true
        scroll.backgroundColor = .white
        text.isEditable = false
        text.isSelectable = true
        text.drawsBackground = true
        text.backgroundColor = .white
        text.textContainerInset = inset
        text.isVerticallyResizable = true
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        text.delegate = self
        text.linkTextAttributes = [.foregroundColor: Palette.acc, .underlineStyle: NSUnderlineStyle.single.rawValue, .cursor: NSCursor.pointingHand]
        text.textStorage?.setAttributedString(attributed)
        scroll.documentView = text

    }
    private let maxWidth: CGFloat?

    /// Keeps a markdown file's column at most 65ch, centred, as the design's.
    func relayout() {
        guard let maxWidth else { return }
        let width = scroll.contentSize.width
        let side = max(24, (width - maxWidth) / 2)
        text.textContainerInset = NSSize(width: side, height: 24)
    }

    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        let href = (link as? URL)?.absoluteString ?? (link as? String) ?? ""
        onLink?(href)
        return true
    }

    func find(_ value: String, step: Int) -> (matches: Int, active: Int) {
        if JSStr.trim(value).isEmpty { clearFind(); return (0, 0) }
        if value != query || step == 0 {
            let found = Self.ranges(in: text.string, value)
            let keep = value == query ? min(active, found.count - 1) : 0
            ranges = found; active = found.isEmpty ? -1 : max(0, keep); query = value
        } else if !ranges.isEmpty {
            active = (active + step + ranges.count) % ranges.count
        }
        paint()
        return (ranges.count, active + 1)
    }

    func clearFind() {
        if let lm = text.layoutManager { lm.removeTemporaryAttribute(.backgroundColor, forCharacterRange: NSRange(location: 0, length: (text.string as NSString).length)) }
        ranges = []; active = -1; query = ""
    }

    private func paint() {
        guard let lm = text.layoutManager else { return }
        let all = NSRange(location: 0, length: (text.string as NSString).length)
        lm.removeTemporaryAttribute(.backgroundColor, forCharacterRange: all)
        for (i, r) in ranges.enumerated() { lm.addTemporaryAttribute(.backgroundColor, value: i == active ? NSColor(hex: "#ff9632") : NSColor(hex: "#ffff00"), forCharacterRange: r) }
        if active >= 0 { text.scrollRangeToVisible(ranges[active]) }
    }

    /// Every place the words are: case aside, each node's text alone; else a passage across them (matchPassage).
    static func ranges(in string: String, _ query: String) -> [NSRange] {
        let hay = string.lowercased() as NSString
        let needle = query.lowercased()
        var out: [NSRange] = []
        var at = 0
        while at < hay.length {
            let r = hay.range(of: needle, options: .literal, range: NSRange(location: at, length: hay.length - at))
            if r.location == NSNotFound { break }
            out.append(r); at = r.location + max(1, r.length)
        }
        if !out.isEmpty || JSStr.trim(query).components(separatedBy: .whitespacesAndNewlines).filter({ !$0.isEmpty }).count < 3 { return out }
        let chars = Array(string)
        var utf16: [Int] = []; var u = 0
        for c in chars { utf16.append(u); u += c.utf16.count }
        utf16.append(u)
        return PassageText.match(string, query, prefixes: true).map { NSRange(location: utf16[$0.start], length: utf16[$0.end] - utf16[$0.start]) }
    }

    // ------------------------------------------------------------------------------------- what the file is drawn as

    static let hSize: [Int: CGFloat] = [1: 22, 2: 18, 3: 16, 4: 14.5, 5: 14.5, 6: 14.5]

    static func runs(_ text: String, font: NSFont, color: NSColor, para: NSParagraphStyle) -> NSAttributedString {
        let out = NSMutableAttributedString()
        for run in StageMarkdown.runs(text) {
            var f = font
            var attrs: [NSAttributedString.Key: Any] = [.foregroundColor: color, .paragraphStyle: para]
            if run.code { f = Fonts.mono(font.pointSize * 0.88); attrs[.backgroundColor] = Palette.hov }
            if run.bold { f = NSFontManager.shared.convert(f, toHaveTrait: .boldFontMask) }
            if run.italic { f = NSFontManager.shared.convert(f, toHaveTrait: .italicFontMask) }
            if let href = run.href { attrs[.link] = href }
            attrs[.font] = f
            out.append(NSAttributedString(string: run.text, attributes: attrs))
        }
        return out
    }

    /// A markdown file as the Stage draws it: 14.5/1.7 sans, headings 22/18/16/14.5, items with their marks and boxes,
    /// quotes with a left rule, code blocks in mono on a tint, rules as a thin line.
    static func markdown(_ source: String) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let base = Fonts.sans(14.5)
        for (i, block) in StageMarkdown.blocks(source).enumerated() {
            let para = NSMutableParagraphStyle()
            para.lineHeightMultiple = 1.7 / 1.2
            if i > 0 { out.append(NSAttributedString(string: "\n", attributes: [.font: base])) }
            switch block {
            case .heading(let level, let text):
                para.paragraphSpacingBefore = i > 0 ? 22 : 0
                para.lineHeightMultiple = 1.35 / 1.2
                out.append(runs(text, font: Fonts.sans(hSize[level] ?? 14.5, weight: level <= 2 ? 500 : 600), color: Palette.ink, para: para))
            case .paragraph(let text):
                para.paragraphSpacingBefore = 10
                out.append(runs(text, font: base, color: Palette.ink, para: para))
            case .item(let ordered, let marker, let depth, let checked, let text):
                para.paragraphSpacingBefore = 4
                para.firstLineHeadIndent = CGFloat(depth) * 22
                para.headIndent = CGFloat(depth) * 22 + 22
                para.tabStops = [NSTextTab(textAlignment: .left, location: CGFloat(depth) * 22 + 22)]
                let mark = checked != nil ? (checked! ? "☑" : "☐") : ordered ? marker : "•"
                out.append(NSAttributedString(string: "\(mark)\t", attributes: [.font: base, .foregroundColor: Palette.fnt, .paragraphStyle: para]))
                out.append(runs(text, font: base, color: checked == true ? Palette.fnt : Palette.ink, para: para))
            case .quote(let text):
                para.paragraphSpacingBefore = 12
                para.firstLineHeadIndent = 14; para.headIndent = 14
                out.append(runs(text, font: base, color: Palette.mut, para: para))
            case .code(_, let text):
                para.paragraphSpacingBefore = 12
                para.lineHeightMultiple = 1.6 / 1.2
                out.append(NSAttributedString(string: text, attributes: [.font: Fonts.mono(12.5), .foregroundColor: Palette.ink, .backgroundColor: Palette.panel2, .paragraphStyle: para]))
            case .rule:
                para.paragraphSpacingBefore = 18
                out.append(NSAttributedString(string: "\u{00A0}\t", attributes: [.font: base, .strikethroughStyle: NSUnderlineStyle.single.rawValue, .strikethroughColor: Palette.bd, .paragraphStyle: para]))
            }
        }
        return out
    }

    /// Other text, as it is: 12.5/1.7 mono, wrapped.
    static func plain(_ source: String) -> NSAttributedString {
        let para = NSMutableParagraphStyle(); para.lineHeightMultiple = 1.7 / 1.2
        return NSAttributedString(string: source, attributes: [.font: Fonts.mono(12.5), .foregroundColor: Palette.ink, .paragraphStyle: para])
    }
}

/// A csv or tsv (Stage.jsx TableView): 2000 rows, the row numbers, the first row the header, 200-wide cells cut with an
/// ellipsis, "N(+) rows · M columns" under it.
final class TableFileView: FlippedView, StageFileView {
    static let shownRows = 2000
    let scroll = NSScrollView()
    private let grid = Grid()
    private let foot = makeLabel("", size: 11.5, color: Palette.fnt)
    var view: NSView { self }

    init(text: String, delimiter: String, truncated: Bool) {
        super.init(frame: .zero)
        fill = Palette.panel2
        let rows = StageModel.parseTable(text, delimiter: delimiter.first ?? ",", limit: Self.shownRows + 1)
        grid.rows = Array(rows.prefix(Self.shownRows))
        grid.width = rows.reduce(0) { max($0, $1.count) }
        grid.frame = NSRect(x: 0, y: 0, width: 48 + CGFloat(grid.width) * 200, height: CGFloat(grid.rows.count) * 34)
        scroll.documentView = grid
        scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = true
        scroll.wantsLayer = true; scroll.layer?.cornerRadius = 8; scroll.layer?.borderWidth = 1; scroll.layer?.borderColor = Palette.bd.cgColor
        foot.stringValue = "\(max(0, grid.rows.count - 1))\(rows.count > Self.shownRows || truncated ? "+" : "") rows · \(grid.width) columns"
        addSubview(scroll); addSubview(foot)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        let height = min(bounds.height - 32 - 28, grid.frame.height + 2)
        scroll.frame = NSRect(x: 16, y: 16, width: bounds.width - 32, height: max(40, height))
        foot.sizeToFit(); foot.frame.origin = NSPoint(x: 16, y: scroll.frame.maxY + 10)
    }

    func find(_ value: String, step: Int) -> (matches: Int, active: Int) {
        let needle = value.lowercased()
        if JSStr.trim(needle).isEmpty { clearFind(); return (0, 0) }
        if value != grid.query || step == 0 {
            var hits: [(Int, Int)] = []
            for (r, row) in grid.rows.enumerated() { for (c, cell) in row.enumerated() where cell.lowercased().contains(needle) { hits.append((r, c)) } }
            grid.active = value == grid.query ? min(grid.active, hits.count - 1) : (hits.isEmpty ? -1 : 0)
            if grid.active < 0 && !hits.isEmpty { grid.active = 0 }
            grid.hits = hits; grid.query = value
        } else if !grid.hits.isEmpty { grid.active = (grid.active + step + grid.hits.count) % grid.hits.count }
        grid.needsDisplay = true
        if grid.active >= 0 { let (r, c) = grid.hits[grid.active]; grid.scrollToVisible(NSRect(x: 48 + CGFloat(c) * 200, y: CGFloat(r) * 34, width: 200, height: 34)) }
        return (grid.hits.count, grid.active + 1)
    }
    func clearFind() { grid.hits = []; grid.active = -1; grid.query = ""; grid.needsDisplay = true }

    final class Grid: NSView {
        var rows: [[String]] = []
        var width = 0
        var hits: [(Int, Int)] = []
        var active = -1
        var query = ""
        override var isFlipped: Bool { true }
        override func draw(_ dirtyRect: NSRect) {
            NSColor.white.setFill(); dirtyRect.fill()
            let first = max(0, Int(dirtyRect.minY / 34)), last = min(rows.count - 1, Int(dirtyRect.maxY / 34))
            guard first <= last else { return }
            let para = NSMutableParagraphStyle(); para.lineBreakMode = .byTruncatingTail
            let right = NSMutableParagraphStyle(); right.alignment = .right
            for r in first...last {
                let y = CGFloat(r) * 34
                if r == 0 { Palette.panel2.setFill(); NSRect(x: 0, y: y, width: bounds.width, height: 34).fill() }
                Palette.bd.setFill()
                if r < rows.count - 1 { NSRect(x: 0, y: y + 33, width: bounds.width, height: 1).fill() }
                NSRect(x: 47, y: y, width: 1, height: 34).fill()
                if r > 0 { NSAttributedString(string: "\(r)", attributes: [.font: Fonts.mono(11), .foregroundColor: Palette.fnt, .paragraphStyle: right]).draw(in: NSRect(x: 10, y: y + 9, width: 28, height: 18)) }
                for c in 0..<width {
                    let x = 48 + CGFloat(c) * 200
                    Palette.bd.setFill(); NSRect(x: x + 199, y: y, width: 1, height: 34).fill()
                    if let i = hits.firstIndex(where: { $0 == (r, c) }) { (i == active ? NSColor(hex: "#ff9632") : NSColor(hex: "#ffff00")).setFill(); NSRect(x: x, y: y, width: 199, height: 33).fill() }
                    let cell = c < rows[r].count ? rows[r][c] : ""
                    NSAttributedString(string: cell, attributes: [.font: Fonts.mono(12, weight: r == 0 ? 500 : 400), .foregroundColor: Palette.ink, .paragraphStyle: para]).draw(in: NSRect(x: x + 12, y: y + 8, width: 176, height: 18))
                }
            }
        }
        override func mouseDown(with event: NSEvent) {
            let p = convert(event.locationInWindow, from: nil)
            let r = Int(p.y / 34), c = Int((p.x - 48) / 200)
            if r >= 0, r < rows.count, c >= 0, c < rows[r].count { toolTip = rows[r][c] }
        }
    }
}

/// A picture (png, jpg, gif, webp, svg; heic through sips), centred, as large as fits.
final class ImageFileView: FlippedView, StageFileView {
    private let image = NSImageView()
    var view: NSView { self }
    init(bytes: Data, name: String) {
        super.init(frame: .zero)
        fill = Palette.panel2
        image.image = NSImage(data: bytes)
        image.imageScaling = .scaleProportionallyDown
        image.animates = true
        image.setAccessibilityLabel(name)
        addSubview(image)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layout() { super.layout(); image.frame = bounds.insetBy(dx: 24, dy: 24) }
    func find(_ text: String, step: Int) -> (matches: Int, active: Int) { (0, 0) }
    func clearFind() {}
}
