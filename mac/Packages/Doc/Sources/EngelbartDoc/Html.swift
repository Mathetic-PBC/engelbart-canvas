import Foundation

// inlineHtml and its relatives as HTML, for the places the Swift app still draws in a web view (a web page's box card,
// the Stage's markdown) and to hold the drawing to doc.js's own tests. The native editor draws InlineRun instead. Math has
// no KaTeX here: a formula is its Unicode text in a `data-math` span (MathText).

public enum InlineHtml {
    static let MENTION_LOOK = "color:#0070f3;font-weight:500;cursor:pointer;border-bottom:1px dotted #c9c9c9"
    static let TRASHED_LOOK = "color:#8f8f8f;font-weight:500;cursor:pointer;border-bottom:1px dotted #d9d9d9"
    static let LINK_LOOK = "color:#0070f3;text-decoration:underline;text-underline-offset:3px;padding:5px 2px;margin:-5px -2px;border-radius:3px;cursor:pointer"
    static let CODE_LOOK = "padding:1px 4px;border-radius:4px;background:#f2f2f2;font:.92em/1.6 var(--font-mono)"
    static let WS_ICON = "<svg viewBox=\"0 0 16 16\" width=\"0.8em\" height=\"0.8em\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linejoin=\"round\" aria-hidden=\"true\" style=\"display:inline-block;vertical-align:-0.06em;margin:0 0.2em 0 0.1em\"><rect x=\"1.5\" y=\"1.5\" width=\"4.5\" height=\"4.5\" rx=\"1\"/><rect x=\"8\" y=\"1.5\" width=\"6.5\" height=\"4.5\" rx=\"1\"/><rect x=\"1.5\" y=\"8\" width=\"6.5\" height=\"6.5\" rx=\"1\"/><rect x=\"10\" y=\"8\" width=\"4.5\" height=\"4.5\" rx=\"1\"/></svg>"
    static func svgIcon(_ body: String) -> String {
        "<svg viewBox=\"0 0 16 16\" width=\"0.8em\" height=\"0.8em\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linejoin=\"round\" stroke-linecap=\"round\" aria-hidden=\"true\" style=\"display:inline-block;vertical-align:-0.06em;margin:0 0.2em 0 0.1em\">\(body)</svg>"
    }
    /// The kind glyphs' SVG bodies (ui/Icons.jsx), shared with the native editor's icon drawing.
    public static let FILE_ICON_PATHS: [String: String] = [
        "pdf": "<path d=\"M3.5 1.5h6l3 3v10h-9z\"/><path d=\"M9.5 1.5v3h3\"/>",
        "md": "<path d=\"M5 1.5h4.5L13 5v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z\"/><path d=\"M9.5 1.5v2A1.5 1.5 0 0 0 11 5h2\"/><path d=\"M5.5 7.75h5M5.5 10h5M5.5 12.25h5\"/>",
        "html": "<path d=\"M5 1.5h4.5L13 5v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z\"/><path d=\"M9.5 1.5v2A1.5 1.5 0 0 0 11 5h2\"/><path d=\"M6.75 8.25 5.25 10l1.5 1.75M9.25 8.25l1.5 1.75-1.5 1.75\"/>",
        "data": "<path d=\"M8 2.5 14 5.5 8 8.5 2 5.5z\"/><path d=\"M2 8.5l6 3 6-3\"/><path d=\"M2 11.5l6 3 6-3\"/>",
        "image": "<rect x=\"1.5\" y=\"2.5\" width=\"13\" height=\"11\" rx=\"1.2\"/><circle cx=\"5.5\" cy=\"6\" r=\"1.25\"/><path d=\"M14.5 10.5 11 7l-4.5 4.5L4.5 9.5 1.5 12.5\"/>",
        "folder": "<path d=\"M1.5 4a1 1 0 0 1 1-1h3.3l1.5 1.8h6.2a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z\"/>",
        "website": "<path d=\"M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5z\"/><path d=\"M1.75 8h12.5\"/><path d=\"M8 1.75c1.8 1.7 2.7 3.8 2.7 6.25S9.8 12.55 8 14.25\"/><path d=\"M8 1.75C6.2 3.45 5.3 5.55 5.3 8s.9 4.55 2.7 6.25\"/>",
        "zotero": "<path d=\"M3 2.5h7.5a1.5 1.5 0 0 1 1.5 1.5v9.5H4.5A1.5 1.5 0 0 1 3 12z\"/><path d=\"M3 12a1.5 1.5 0 0 1 1.5-1.5H12\"/>",
    ]
    static let GIT_ICON = "<svg viewBox=\"0 0 16 16\" width=\"0.8em\" height=\"0.8em\" fill=\"currentColor\" aria-hidden=\"true\" style=\"display:inline-block;vertical-align:-0.06em;margin:0 0.2em 0 0.1em\"><path d=\"M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z\"/></svg>"
    /// Lucide's hammer (model/hammer.js), `size` px square.
    public static let HAMMER_PATHS = "<path d=\"m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9\"></path><path d=\"m18 15 4-4\"></path><path d=\"m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5\"></path>"
    public static func hammerSvg(_ size: Int = 16, width: Double = 1.5) -> String {
        "<svg width=\"\(size)\" height=\"\(size)\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"\(width == width.rounded() ? String(Int(width)) : String(width))\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\(HAMMER_PATHS)</svg>"
    }

    static func icon(_ i: MentionIcon?) -> String {
        switch i {
        case .workspace?: return WS_ICON
        case .git?: return GIT_ICON
        case .website?: return svgIcon(FILE_ICON_PATHS["website"]!)
        case .zotero?: return svgIcon(FILE_ICON_PATHS["zotero"]!)
        case .file(let kind)?: return svgIcon(FILE_ICON_PATHS[kind == "file" ? "pdf" : kind] ?? FILE_ICON_PATHS["pdf"]!)
        case nil: return ""
        }
    }

    static let esc = Doc.esc

    /// inlineHtml(text, opts).
    public static func html(_ text: String, _ opts: InlineOpts? = nil) -> String { html(runs: Inline.runs(text, opts), opts ?? InlineOpts()) }

    public static func html(runs: [InlineRun], _ opts: InlineOpts) -> String { runs.map { html(run: $0, opts) }.joined() }

    static func html(run: InlineRun, _ opts: InlineOpts) -> String {
        switch run {
        case .text(let t, _): return esc(t)
        case .math(_, let display, let shown, _): return "<span data-math=\"1\" contenteditable=\"false\"\(display ? " style=\"display:block;text-align:center\"" : "")>\(esc(shown))</span>"
        case .mathError(let src): return "<code data-math-error=\"1\" style=\"\(CODE_LOOK)\">\(esc(src))</code>"
        case .buildIcon(let turn):
            let acts = turn.map { " data-act=\"footbuild\" data-turn=\"\($0)\" role=\"button\" aria-label=\"Build\" title=\"Build\"" } ?? " aria-hidden=\"true\""
            return "<span data-build-icon=\"1\" contenteditable=\"false\"\(acts) style=\"display:inline-flex;color:#4d4d4d;vertical-align:-2px;user-select:none\(turn != nil ? ";cursor:pointer" : "")\">\(hammerSvg(14))</span>"
        case .attachment(let label, let id, _):
            return "<span data-attachment=\"\(esc(id))\" style=\"padding:1px 6px;border-radius:4px;background:#f2f2f2;border:1px solid #eaeaea;font:.86em/1.6 var(--font-mono);color:#4d4d4d;white-space:nowrap\">[\(esc(label))]</span>"
        case .strong(let inner, _): return "<strong style=\"font-weight:600\">\(html(runs: inner, opts))</strong>"
        case .code(let t, _): return "<code style=\"\(CODE_LOOK)\">\(esc(t))</code>"
        case .em(let t, _): return "<em>\(esc(t))</em>"
        case .agent(let t): return "<span style=\"color:#0070f3;font-weight:500\">\(esc(t))</span>"
        case .gone(let shown, let why, _): return "<span title=\"\(esc(why))\" style=\"color:#8f8f8f\">@\(esc(shown))</span>"
        case .link(let title, let href, _): return "<a href=\"\(esc(href))\" data-link=\"1\" style=\"\(LINK_LOOK)\">\(esc(title))</a>"
        case .citation(let c, let n, let source): return citationHtml(c, n: n, source: source, opts)
        case .citeRun(let first, let more, let rest):
            return "<span data-cite-run=\"1\">\(html(run: first, opts))\(citationMoreHtml(more))<span data-cite-rest=\"1\">\(html(runs: rest, opts))</span></span>"
        case .mention(let c, _):
            let ic = icon(c.icon)
            switch c.kind {
            case .workspace(let id):
                return "<span data-mention=\"\(esc(c.name))\" data-ws=\"\(esc(id))\" style=\"\(MENTION_LOOK);white-space:nowrap\">@\(ic)\(esc(c.shown))</span>"
            case .library(let id):
                return "<span data-mention=\"\(esc(c.shown))\" data-lib=\"\(esc(id))\"\(c.trashed ? " title=\"In trash\"" : "") style=\"\(c.trashed ? TRASHED_LOOK : MENTION_LOOK)\(ic.isEmpty ? "" : ";white-space:nowrap")\">@\(ic)\(esc(c.shown))</span>"
            case .file(let folderId, let rel):
                let look = c.missing ? "color:#8f8f8f;font-weight:500;cursor:pointer;border-bottom:1px dotted #d9d9d9;text-decoration:line-through;text-decoration-color:#c9c9c9" : MENTION_LOOK
                return "<span data-mention=\"\(esc(c.name))\" data-folder=\"\(esc(folderId))\" data-file=\"\(esc(rel))\"\(c.missing ? " data-missing=\"1\"" : "") title=\"\(esc(c.title ?? ""))\" style=\"\(look);white-space:nowrap\">@\(ic)\(esc(c.shown))</span>"
            case .zotero(let ref):
                return "<span data-mention=\"\(esc(c.name))\" data-zotero=\"\(esc(ref))\" title=\"Zotero\" style=\"\(MENTION_LOOK);white-space:nowrap\">@\(ic)\(esc(c.shown))</span>"
            case .made(let key):
                return "<span data-mention=\"\(esc(c.name))\" data-made=\"\(esc(key))\" style=\"\(MENTION_LOOK);white-space:nowrap\">@\(esc(c.shown))</span>"
            case .url(let address):
                return "<span data-mention=\"\(esc(c.name))\" data-url=\"\(esc(address))\" title=\"\(esc(address))\" style=\"\(MENTION_LOOK);white-space:nowrap\">@\(ic)\(esc(c.shown))</span>"
            case .name, .chat:
                return "<span data-mention=\"\(esc(c.name))\"\(c.trashed ? " title=\"In trash\"" : "") style=\"\(c.trashed ? TRASHED_LOOK : MENTION_LOOK)\(ic.isEmpty ? "" : ";white-space:nowrap")\">@\(ic)\(esc(c.shown))</span>"
            }
        }
    }

    /// A citation's circle (cite.js citationHtml).
    public static func citationHtml(_ c: Citation, n: Int, source: String, _ opts: InlineOpts) -> String {
        let said = c.counter ? "Against this" : c.cite == "you" ? "Your words" : c.cite == "other" ? "Someone else’s words" : "A source"
        let quoted = c.note.map { "Your note: “\($0)”" } ?? (!c.find.isEmpty ? "“\(c.find)”" : "The whole source")
        var out = "<a href=\"\(esc(c.href))\" data-link=\"1\" data-cite=\"\(esc(c.cite))\" data-n=\"\(n)\" data-key=\"\(esc(c.key))\" data-label=\"\(esc(c.label))\" data-find=\"\(esc(c.find))\""
        if let note = c.note { out += " data-note=\"\(esc(note))\"" }
        out += " data-source=\"\(esc(source))\"\(c.cite == "you" ? " data-you=\"1\"" : "")\(c.counter ? " data-counter=\"1\"" : "") contenteditable=\"false\""
        if opts.citeFocus { out += " tabindex=\"0\"" }
        if opts.citeTitle { out += " title=\"\(esc("\(c.label)\n\(quoted)\n\(source)"))\"" }
        out += " aria-label=\"\(esc("\(n): \(c.label), \(said). \(quoted) — \(source)"))\"></a>"
        return out
    }

    /// The "…" circle of a folded run.
    public static func citationMoreHtml(_ more: Int) -> String {
        "<span data-cite-more=\"1\" data-n=\"…\" contenteditable=\"false\" role=\"button\" aria-label=\"\(more) more \(more == 1 ? "citation" : "citations")\" title=\"\(more) more\"></span>"
    }

    /// Text as typed with only its math drawn.
    public static func textMathHtml(_ text: String?) -> String {
        Inline.textMathRuns(text).map { r -> String in
            if case .text(let t, _) = r { return esc(t) }
            return html(run: r, InlineOpts())
        }.joined()
    }

    /// A margin note as shown while it is not being edited (doc.js noteHtml).
    public static func noteHtml(_ text: String?, _ opts: InlineOpts? = nil, agents: Bool = false) -> String {
        Inline.noteRuns(text, opts, agents: agents).map { r -> String in
            if case .agent(let t) = r { return agentLabelHtml(t) }
            return html(run: r, opts ?? InlineOpts())
        }.joined()
    }

    /// An agent's name in a note, as the document's label, kept at the note's own width.
    public static func agentLabelHtml(_ token: String) -> String {
        "<span data-agent=\"\(esc(token.slice(1).lowercased()))\" style=\"position:relative;color:transparent\">\(esc(token))<span aria-hidden=\"true\" style=\"position:absolute;left:0;top:50%;transform:translateY(-50%);color:#0070f3;font:500 .75em/1 var(--font-sans);letter-spacing:normal;white-space:nowrap;user-select:none;pointer-events:none\">\(esc(token))</span></span>"
    }

    /// A note's field's backdrop: the text as typed, its leading @bart a label.
    public static func noteInkHtml(_ text: String?) -> String {
        let s = text ?? ""
        guard let lead = Inline.NOTE_AGENT.match(s) else { return esc(s) }
        return esc(lead[1] ?? "") + agentLabelHtml(lead[2]!) + esc(s.slice(lead.str.len))
    }
}
