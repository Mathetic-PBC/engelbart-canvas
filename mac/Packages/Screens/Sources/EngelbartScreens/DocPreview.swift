import EngelbartDoc
import EngelbartUI
import SwiftUI

// A document the way the workspace shows it, read-only (port of src/renderer/ui/DocPreview.jsx): bold, italic, code,
// links and mentions; tasks and bullets as dashes, numbered rows by their numbers. Home's workspace tiles (24 lines at
// 10.5px), the workspace peek (13px) and an md row's peek (12.5px) draw it.

/// One line of a preview, as DocPreview.jsx decides it.
public enum PreviewLine: Equatable {
    case codeBody(String)
    case code(String)
    case gap
    case heading([InlineRun])
    case item(mark: String, depth: Int, done: Bool, [InlineRun])
    case answer([InlineRun])
    case plain([InlineRun])
}

public enum DocPreviewModel {
    /// What a hidden line is: nothing to read in a preview.
    static func hidden(_ p: ParsedLine) -> Bool {
        p.type == .pending || p.type == .img || p.type == .fence || p.code == .open || p.code == .close || (p.type == .p && p.text.trimmed.isEmpty)
    }

    /// Where the last `n` lines that show something begin.
    static func tailStart(_ parsed: [ParsedLine], _ n: Int) -> Int {
        var left = n
        for i in stride(from: parsed.count - 1, through: 0, by: -1) {
            if hidden(parsed[i]) { continue }
            left -= 1
            if left == 0 { return i }
        }
        return 0
    }

    /// The lines drawn: a leading blank line dropped; `tail`: the last lines that hold something, read in the context of
    /// the whole (a code block stays one); at most `maxLines` from there.
    public static func lines(_ text: String, maxLines: Int? = nil, tail: Int? = nil) -> [PreviewLine] {
        let trimmed = text.replacingOccurrences(of: "^\\s*\\n", with: "", options: .regularExpression)
        let lines = Doc.lines(trimmed)
        let parsed = Doc.parseLines(lines)
        let from = tail.map { tailStart(parsed, $0) } ?? 0
        let end = maxLines.map { min(lines.count, from + $0) } ?? lines.count
        var out: [PreviewLine] = []
        guard from < end else { return out }
        for index in from..<end {
            let p = parsed[index], line = lines[index]
            if p.type == .pending || p.type == .img || p.type == .fence || p.code == .open || p.code == .close { continue }
            if p.code == .body { out.append(.codeBody(p.text.isEmpty ? "\u{00a0}" : p.text)); continue }
            if p.type == .code { out.append(.code(line.isEmpty ? "\u{00a0}" : line)); continue }
            if p.type == .p && p.text.trimmed.isEmpty { out.append(.gap); continue }
            let source = p.type == .bart ? "@\(Doc.tokenOf(Doc.agentOf(p))) \(p.text)" : p.text
            let runs = Inline.runs(source)
            if p.type == .h { out.append(.heading(runs)); continue }
            if p.type == .todo || p.type == .list {
                let done = p.type == .todo && p.done
                let mark = done ? "✓" : (p.type == .list && p.num != nil ? Doc.listMark(p) : "–")
                out.append(.item(mark: mark, depth: p.depth, done: done, runs)); continue
            }
            if p.type == .reply || p.type == .quote { out.append(.answer(runs)); continue }
            out.append(.plain(runs))
        }
        return out
    }

    /// The runs as one attributed string at `size` (inlineHtml's looks: strong 600, code on #f2f2f2 at .92em mono,
    /// agents and mentions blue 500, links blue underlined, a mention that names nothing grey).
    public static func attributed(_ runs: [InlineRun], size: CGFloat, weight: Int = 400, color: NSColor = Palette.ink) -> AttributedString {
        var out = AttributedString()
        for run in runs { out += piece(run, size: size, weight: weight, color: color, italic: false) }
        return out
    }

    static func piece(_ run: InlineRun, size: CGFloat, weight: Int, color: NSColor, italic: Bool) -> AttributedString {
        func text(_ s: String, font: NSFont, color: NSColor, background: NSColor? = nil, underline: Bool = false) -> AttributedString {
            var a = AttributedString(s)
            a.font = italic ? NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) : font
            a.foregroundColor = color
            if let background { a.backgroundColor = background }
            if underline { a.underlineStyle = .single }
            return a
        }
        let base = Fonts.sans(size, weight: weight)
        switch run {
        case .text(let s, _): return text(s, font: base, color: color)
        case .strong(let inner, _):
            var out = AttributedString()
            for r in inner { out += piece(r, size: size, weight: 600, color: color, italic: italic) }
            return out
        case .em(let s, _):
            return text(s, font: NSFontManager.shared.convert(base, toHaveTrait: .italicFontMask), color: color)
        case .code(let s, _): return text(s, font: Fonts.mono(size * 0.92), color: color, background: Palette.hov)
        case .agent(let s): return text(s, font: Fonts.sans(size, weight: 500), color: Palette.acc)
        case .mention(let chip, _):
            return text("@\(chip.shown)", font: Fonts.sans(size, weight: 500), color: chip.trashed || chip.missing ? Palette.fnt : Palette.acc)
        case .gone(let shown, _, _): return text("@\(shown)", font: base, color: Palette.fnt)
        case .link(let title, _, _): return text(title, font: base, color: Palette.acc, underline: true)
        case .math(_, _, let shown, _): return text(shown, font: base, color: color)
        case .mathError(let s): return text(s, font: Fonts.mono(size * 0.92), color: color, background: Palette.hov)
        case .attachment(let label, _, _): return text("[\(label)]", font: Fonts.mono(size * 0.86), color: Palette.mut, background: Palette.hov)
        case .buildIcon: return AttributedString()
        case .citation(_, let n, _): return text("\(n)", font: Fonts.sans(size * 0.75, weight: 500), color: Palette.mut)
        case .citeRun(let first, _, _):
            return piece(first, size: size, weight: weight, color: color, italic: italic) + text("…", font: base, color: Palette.mut)
        }
    }
}

/// `<DocPreview text maxLines tail size>`: 1.45 line height, ink, wrapping anywhere.
public struct DocPreview: View {
    let text: String
    let maxLines: Int?
    let tail: Int?
    let size: CGFloat

    public init(text: String, maxLines: Int? = nil, tail: Int? = nil, size: CGFloat = 10.5) {
        self.text = text; self.maxLines = maxLines; self.tail = tail; self.size = size
    }

    private var style: TextStyle { TextStyle(size, lineHeight: 1.45) }
    private var em: CGFloat { size }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(DocPreviewModel.lines(text, maxLines: maxLines, tail: tail).enumerated()), id: \.offset) { _, line in
                lineView(line)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func lineView(_ line: PreviewLine) -> some View {
        switch line {
        case .codeBody(let s):
            Text(s).font(Font(Fonts.mono(em * 0.92))).lineSpacing(em * 0.92 * 0.3).foregroundStyle(Color(Palette.mut))
                .padding(.leading, em * 0.7)
                .overlay(alignment: .leading) { Rectangle().fill(Color(Palette.bd)).frame(width: 2) }
                .frame(maxWidth: .infinity, alignment: .leading)
        case .code(let s):
            Text(s).font(Font(Fonts.mono(em * 0.92))).lineSpacing(em * 0.92 * 0.3).foregroundStyle(Color(Palette.ink))
                .padding(.horizontal, em * 0.6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(Palette.panel2))
        case .gap:
            Color.clear.frame(height: em * 0.6)
        case .heading(let runs):
            Text(DocPreviewModel.attributed(runs, size: size, weight: 600)).lineSpacing(style.lineSpacing)
                .padding(.top, em * 0.35).padding(.bottom, em * 0.15)
        case .item(let mark, let depth, let done, let runs):
            HStack(alignment: .firstTextBaseline, spacing: em * 0.45) {
                Text(mark).font(Font(Fonts.sans(size))).foregroundStyle(Color(done ? Palette.fnt : Palette.ink))
                Text(DocPreviewModel.attributed(runs, size: size, color: done ? Palette.fnt : Palette.ink))
                    .strikethrough(done, color: Color(Palette.fnt))
                    .lineSpacing(style.lineSpacing)
            }
            .padding(.leading, em * (0.6 + CGFloat(depth) * 0.9))
        case .answer(let runs):
            Text(DocPreviewModel.attributed(runs, size: size, color: Palette.mut)).lineSpacing(style.lineSpacing)
                .padding(.leading, em * 0.7)
                .overlay(alignment: .leading) { Rectangle().fill(Color(Palette.bd)).frame(width: 2) }
                .frame(maxWidth: .infinity, alignment: .leading)
        case .plain(let runs):
            Text(DocPreviewModel.attributed(runs, size: size)).lineSpacing(style.lineSpacing)
        }
    }
}
