import AppKit
import EngelbartCore
import EngelbartDoc
import EngelbartUI

// The document editor (DocEditor.jsx): one markdown document, its caret's line showing its source and every other line
// its drawing, the @ menu, the model selector, answer cards with their controls, find, pictures. The model is
// EditorCore; this view draws it into a DocTextView and turns events into calls on it. It talks to the outside only
// through `host` (DocEditorHost), so the Workspace screen and a post-it's small editor (`compact`) embed it alike.

public final class DocEditorView: NSView, NSTextViewDelegate {
    public let core = EditorCore()
    public weak var host: DocEditorHost? { didSet { wireHooks(); redraw() } }
    /// A post-it's editor: no scrolling of its own, no card controls, menus kept inside it.
    public var compact = false { didSet { needsLayout = true } }
    public var readOnly = false { didSet { core.readOnly = readOnly; textView.isEditable = !readOnly; redraw() } }
    /// Where scroll positions are kept (props.viewScope): the workspace.
    public var viewScope: String?
    /// Titled conversations left open collapse when the document is shown (props.autoCollapse).
    public var autoCollapse = false { didSet { core.autoCollapseOn = autoCollapse } }
    /// The grey hint on an empty last line ("Write your thoughts…", 2026-10-09).
    public var emptyHint: String? { didSet { needsDisplay = true } }
    /// The mention whose document is open beside this one (MATH-23): a note's name, a workspace's id.
    public var besideLink: String? { didSet { redraw() } }
    public var besideWorkspace: String? { didSet { redraw() } }
    /// How tall the document is drawn (a post-it sizes its card to it).
    public private(set) var contentHeight: CGFloat = 0
    /// ⌘F/⌘G are this editor's own (the Workspace may route them elsewhere: model/key-side.js).
    public var handlesFind = true

    let scroll = NSScrollView()
    let textView: DocTextView
    let layoutManager = DocLayoutManager()
    var rendered = Rendered(text: NSAttributedString(), maps: [], decos: [])
    var overlays: [NSView] = []
    var syncing = false
    var composing = false
    var byMouse = false
    let saver = Debouncer(delay: 0.4)
    var viewTimer: Timer?
    var settle: (key: String, pos: ViewPosition, until: Date)?
    var lastKey: String?
    /// Run rows' and reply fields' heights as last measured.
    var heights: [String: CGFloat] = [:]
    var openLogs = Set<String>()
    // Popups
    var mention: MentionState?
    var mentionMenu: MentionMenuView?
    var picker: PickerView?
    var pop: HoverCardView?
    var findBar: FindBarView?
    var flashLine: (line: Int, until: Date)?
    /// A library folder opened in the @ menu (FolderMenu).
    var browse: Browse?
    var browsingRedraw = false
    /// Answers opened past their cut (Show more), by answerKey; what each answer measured (the line offset it is cut at, or
    /// -1 short), for the column width it was measured at; the cuts applied now.
    var moreOpen = Set<String>()
    var measured: [String: Int] = [:]
    var measuredWidth: CGFloat = 0
    var clipFrom: [Int: Int] = [:]
    var measuring = false
    var askHold: AskHold?
    var replyWait: ReplyWait?
    /// When a key last reached the editor, and the pane was last scrolled with the wheel.
    var keyedAt = Date.distantPast
    var wheelAt = Date.distantPast
    var pressing: Bool { textView.pressing }
    /// A run's answer-so-far box the person scrolled up in: where they left it (follows the newest line otherwise).
    var streamHeld: [String: CGFloat] = [:]
    /// Cards, Send to Discover, bookmarks and made rows (CardsWiring).
    let cards = CardsState()
    var appActiveHook: (() -> Bool)?
    /// Zotero items main is finding a free copy for, and waiting on the Downloads folder for (MATH-65 builds 3, 4).
    public var zoteroFinding = Set<String>() { didSet { redraw(keepSelection: true) } }
    public var zoteroWaiting = Set<String>() { didSet { redraw(keepSelection: true) } }

    struct MentionState { var line: Int?; var field: Int?; var query: String; var start: Int; var caret: Int; var index: Int; var items: [MenuItem] }

    public override init(frame: NSRect) {
        let storage = NSTextStorage()
        storage.addLayoutManager(layoutManager)
        let container = NSTextContainer(size: NSSize(width: 620, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = false
        layoutManager.addTextContainer(container)
        textView = DocTextView(frame: frame, textContainer: container)
        super.init(frame: frame)
        textView.editor = self
        textView.delegate = self
        textView.isRichText = true
        textView.allowsUndo = false
        textView.drawsBackground = true
        textView.backgroundColor = Palette.bg
        textView.insertionPointColor = Look.ink
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isContinuousSpellCheckingEnabled = false
        textView.smartInsertDeleteEnabled = false
        textView.usesFindBar = false
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.selectedTextAttributes = [.backgroundColor: NSColor(srgbRed: 0, green: 112 / 255, blue: 243 / 255, alpha: 0.18)]
        textView.linkTextAttributes = [:]
        textView.setAccessibilityLabel("Document")
        scroll.documentView = textView
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.contentView.postsBoundsChangedNotifications = true
        addSubview(scroll)
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
        wireHooks()
    }
    required init?(coder: NSCoder) { fatalError() }
    deinit { NotificationCenter.default.removeObserver(self); saver.flush() }

    public override var isFlipped: Bool { true }

    // MARK: hooks

    func wireHooks() {
        core.hooks.changed = { [weak self] text in
            guard let self else { return }
            self.host?.docEditor(self, changed: text)
            let key = self.core.docKey
            self.saver.call { [weak self] in guard let self else { return }; self.host?.docEditor(self, save: text, key: key) }
        }
        let canAsk = host.map { $0.docEditorCanAsk(self) } ?? false
        core.hooks.ask = canAsk ? { [weak self] req in guard let self else { return }; self.host?.docEditor(self, ask: req) } : nil
        core.hooks.route = (host?.docEditorHasRouter(self) ?? false) ? { [weak self] req, done in guard let self else { return }; self.host?.docEditor(self, route: req, done: done) } : nil
        core.hooks.routeGone = { [weak self] id in guard let self else { return }; self.host?.docEditor(self, routeGone: id) }
        core.hooks.stopAsk = { [weak self] id in guard let self else { return }; self.host?.docEditor(self, stop: id) }
        core.hooks.build = (host?.docEditorCanBuild(self) ?? false) ? { [weak self] req in guard let self else { return }; self.host?.docEditor(self, build: req) } : nil
        core.hooks.noteVerb = { [weak self] name, done in guard let self else { return }; self.host?.docEditor(self, makeNote: name, done: done) }
        core.hooks.asked = { [weak self] id in self?.asked(id) }
        core.hooks.mentionPicked = { [weak self] row in guard let self else { return }; self.host?.docEditor(self, picked: row) }
        core.hooks.docTextOf = { [weak self] key in guard let self else { return nil }; return self.host?.docEditor(self, textOf: key) }
        core.hooks.changeDoc = { [weak self] key, text in guard let self else { return }; self.host?.docEditor(self, change: key, text: text) }
        core.models = host?.docEditorModels(self)
    }

    // MARK: public entry points (DocEditor's props and ref methods)

    /// Show another document (props.docKey + props.text). Its question being edited goes back as it was; the place it
    /// was scrolled to is reported, and the new one's is put back.
    public func setDocument(key: String, text: String) {
        if lastKey != nil { reportView(now: true); saver.flush() }
        closePopups()
        moreOpen = []; measured = [:]; clipFrom = [:]; askHold = nil; replyWait = nil; streamHeld = [:]
        cards.repick = nil; cards.discoverOpen = []; cards.discoverText = [:]; cards.asked = []; unpeekMade()
        core.setDocument(key: key, text: text)
        lastKey = key
        redraw()
        restoreView()
    }
    /// The text changed outside the editor (an answer landed, another window saved, an undo in the window).
    public func setText(_ text: String) {
        guard text != core.text else { return }
        core.receive(text: text)
        redraw()
        replyArrived()
    }
    /// The runs at work (Workspace `asks`): their rows are drawn again, the caret untouched.
    public func setAsks(_ asks: [String: AskProgress]) { core.asks = asks; redraw(keepSelection: true) }
    /// What each Build's record says (props.builds).
    public func setBuilds(_ builds: [String: BuildState]) { core.builds = builds; core.autoCollapse(); redraw(keepSelection: true) }
    /// The models file changed (props.models).
    public func setModels(_ models: QuestionModels?) { core.models = models; redraw(keepSelection: true) }
    /// What the host answers for made files (madeFile) or a guide's papers (paperState) changed: drawn again, the caret
    /// untouched (props.madeFiles / props.paperState changing).
    public func rowsChanged() { redraw(keepSelection: true) }
    /// Write what is waiting to be saved now (the window closing, the document left).
    public func flush() { saver.flush(); reportView(now: true) }
    /// The caret at the start of the document (a freshly created note).
    public func focusStart() { core.caret = CaretPlace(line: 0, offset: 0); core.activeLine = 0; redraw(); window?.makeFirstResponder(textView) }
    /// The caret at the end of the last line.
    public func focusEnd() { core.focusEnd(); redraw(); window?.makeFirstResponder(textView) }
    /// A line is being edited or the @ menu is open (the window's Escape checks this).
    public var isActive: Bool { core.activeLine != nil || mention != nil }
    /// The window's Escape with the key elsewhere: the @ menu, the selector or a hover card shuts. → whether one was open.
    @discardableResult public func shutMenus() -> Bool { let open = mentionMenu != nil || picker != nil || pop != nil; closePopups(); return open }
    /// The caret where it is now, on one line; nil when the selection runs over lines.
    public func caretNow() -> (line: Int, a: Int, b: Int)? { guard let s = docSelection(), s.sameLine else { return nil }; return (s.anchor.line, s.start.offset, s.end.offset) }
    /// The keyboard back in the document with `line`/`a…b` selected, as a click would put it. → whether it went.
    @discardableResult public func placeCaret(line: Int, a: Int, b: Int) -> Bool {
        let ls = core.lines
        guard !readOnly, line < ls.count, !core.lockedAt(ls, line) else { return false }
        let end = core.lineText(ls, line).len
        core.caret = CaretPlace(line: line, sel: (min(a, end), min(b, end))); core.activeLine = line
        redraw(); window?.makeFirstResponder(textView); return true
    }
    /// The walkthrough's Brainstorm button: `@<agent>` asked at the end of the document.
    @discardableResult public func startAgent(_ agent: String) -> Bool { let ok = core.startAgent(agent); redraw(); scrollToEnd(); return ok }
    /// A research box the window put under Discover's reply, asked from here. False until its lines are in.
    @discardableResult public func askBoxed(_ askId: String) -> Bool { let ok = core.askBoxed(askId); redraw(); return ok }
    /// The router's pick for a line asked here, delivered later by the window.
    @discardableResult public func handOff(_ askId: String, pick: RoutePick, key: String? = nil) -> String? { let r = core.handOff(askId, pick, key: key); redraw(); return r }
    /// Collapse all / Expand all (the page's top-right words).
    public func foldAll(_ collapse: Bool) { core.foldAll(collapse); redraw() }
    public var anyAnswerOpen: Bool { core.foldable().contains { !$0.folded } }

    // MARK: drawing

    func renderContext() -> RenderContext {
        var ctx = RenderContext()
        let rows = host?.docEditorMentionable(self) ?? []
        let known = rows.contains { $0.row.type != "chat" }
        func find(_ name: String, _ id: String?) -> EditorRow? {
            if let id { return rows.first { $0.row.type != "chat" && $0.row.id == id } }
            if let chat = Inline.chatMention(name) { return chat.live ? rows.first { $0.row.id == "bart" } : nil }
            let n = name.lowercased()
            return rows.first { $0.row.id != "bart" && $0.row.id != "chat" && $0.row.name.lowercased() == n }
                ?? (WebName.isAddress(name) ? rows.first { Mention.isWebRow($0.row) && WebName.sameAddress($0.row.url, name) } : nil)
        }
        ctx.opts.libName = { id in guard known else { return .unknown }; return find("", id).map { .name($0.row.name) } ?? .gone }
        ctx.opts.named = { name in known ? find(name, nil) != nil : nil }
        ctx.opts.trashed = { name, id in (id != nil ? find("", id) : find(name, nil))?.trashed ?? false }
        ctx.opts.webKind = { name, id in
            guard let row = (id != nil ? find("", id) : find(name, nil))?.row, Mention.isWebRow(row) else { return nil }
            return Kind.kindKey(row) == "git" ? "git" : "website"
        }
        ctx.opts.fileState = { [weak self] f, r in guard let self else { return .unknown }; return self.host?.docEditor(self, fileState: f, rel: r) ?? .unknown }
        ctx.opts.citeSource = { address in Cite.libraryName(rows.map { $0.row }, address) }
        ctx.image = { [weak self] id in guard let self else { return nil }; return self.host?.docEditor(self, image: id) }
        ctx.canReply = core.hooks.ask != nil && !compact
        ctx.hasRouter = core.hooks.route != nil
        ctx.byMouse = byMouse
        if let s = core.caret, s.line == core.activeLine { ctx.reveal = (s.a, s.b) }
        else if let s = docSelection(), s.sameLine, s.anchor.line == core.activeLine { ctx.reveal = (s.start.offset, s.end.offset) }
        ctx.columnWidth = textView.textContainer?.size.width ?? 620
        let width = ctx.columnWidth, paneH = scroll.contentSize.height
        ctx.rowHeight = { [weak self] deco in self?.measure(deco, width: width, pane: paneH) ?? 44 }
        ctx.clipFrom = clipFrom
        ctx.paperState = { [weak self] address in guard let self, let host = self.host else { return nil }; return self.cards.saving[address] ?? host.docEditor(self, paperState: address) }
        ctx.zoteroFinding = zoteroFinding; ctx.zoteroWaiting = zoteroWaiting
        let mores = moreKeys()
        ctx.more = { q in mores[q] }
        ctx.beside = { [weak self] chip in
            guard let self else { return false }
            if case .workspace(let id) = chip.kind { return self.besideWorkspace == id }
            if case .name = chip.kind { return self.besideLink?.lowercased() == chip.name.lowercased() }
            if case .library = chip.kind { return self.besideLink?.lowercased() == chip.name.lowercased() }
            return false
        }
        return ctx
    }

    func measure(_ deco: Deco, width: CGFloat, pane: CGFloat) -> CGFloat {
        if let h = cardsMeasure(deco, width: width) { return h }
        switch deco {
        case .pending(let id):
            let v = PendingView(progress: core.asks[id], waitLeft: core.waits[id]?.left, logOpen: openLogs.contains(id))
            return v.wantedHeight(width: width, cap: min(240, max(120, pane * 0.35)))
        case .build(let id):
            if let v = host?.docEditor(self, buildView: id) { return max(44, v.fittingSize.height) + 20 }
            return 44
        case .replyField(let from, _):
            return ReplyFieldView.height(for: core.followText[from] ?? "", width: width)
        case .research(let state, _): return state == "running" ? 50 : 86
        default: return 44
        }
    }

    /// Draw the document again from the model; the caret goes where the model says (an edit) or stays where it was.
    func redraw(keepSelection: Bool = false) {
        guard !syncing else { return }
        // Mid-composition the storage holds the IME's marked text: drawn again once it commits (typed → redraw).
        if textView.hasMarkedText() { return }
        if core.normalize() { }
        syncing = true
        defer { syncing = false }
        let keep = keepSelection || core.caret == nil ? docSelection() : nil
        let hadFocus = window?.firstResponder === textView
        layoutColumn()
        let ctx = renderContext()
        rendered = Renderer.render(core, ctx)
        textView.textStorage?.setAttributedString(rendered.text)
        textView.typingAttributes = [.font: Fonts.sans(Look.body), .foregroundColor: Look.ink]
        layoutManager.ensureLayout(for: textView.textContainer!)
        if let c = core.caret {
            core.caret = nil
            setSelection(DocSelection(anchor: DocPoint(line: c.line, offset: c.back ? c.b : c.a), focus: DocPoint(line: c.line, offset: c.back ? c.a : c.b)))
            if hadFocus || window?.firstResponder == nil { window?.makeFirstResponder(textView) }
            textView.scrollRangeToVisible(textView.selectedRange())
        } else if let keep { setSelection(keep) }
        if measureClips() { return }
        sizeToContent()
        placeOverlays()
        applyFlash()
        keepAsked()
        // The pending line of the question just asked, noted while it is there: its answer landing is read against it.
        if var w = replyWait, w.line < 0, let at = core.lines.firstIndex(of: "bart~> \(w.askId)") { w.line = at; replyWait = w }
        if let f = findBar { f.refind(keepAt: true) }
        updateMention()
        needMade()
    }

    func layoutColumn() {
        let width = scroll.contentSize.width
        let column = compact ? width : Look.column(for: width)
        let inset = compact ? 0 : max(0, (width - column) / 2)
        textView.textContainerInset = NSSize(width: inset, height: compact ? 0 : 28 + 18)
        textView.textContainer?.size = NSSize(width: column, height: .greatestFiniteMagnitude)
        textView.minSize = NSSize(width: width, height: compact ? 28 : scroll.contentSize.height)
        textView.maxSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        textView.frame.size.width = width
    }

    public override func layout() {
        super.layout()
        scroll.frame = bounds
        let w = textView.textContainer?.size.width
        layoutColumn()
        if w != textView.textContainer?.size.width { redraw(keepSelection: true) } else { placeOverlays() }
        // Past the last line the page keeps going for about half a window (2026-09-22).
        if !compact { textView.textContainerInset.height = 46 }
    }

    // MARK: places in the document

    func map(forStorage idx: Int) -> LineMap? {
        let maps = rendered.maps
        var lo = 0, hi = maps.count - 1
        while lo <= hi {
            let mid = (lo + hi) / 2, r = maps[mid].range
            if idx < r.location { hi = mid - 1 } else if idx > NSMaxRange(r) { lo = mid + 1 } else { return maps[mid] }
        }
        return maps.last
    }
    func docPoint(_ idx: Int) -> DocPoint {
        guard let m = map(forStorage: idx) else { return DocPoint(line: 0, offset: 0) }
        if m.widget { return DocPoint(line: m.line, offset: 0) }
        return DocPoint(line: m.line, offset: m.toRaw(max(0, min(m.range.length, idx - m.range.location))))
    }
    func storageIndex(_ p: DocPoint) -> Int {
        guard p.line >= 0 && p.line < rendered.maps.count else { return textView.string.utf16.count }
        let m = rendered.maps[p.line]
        return m.range.location + min(m.range.length, m.toDisplay(p.offset))
    }
    func docSelection() -> DocSelection? {
        guard !rendered.maps.isEmpty else { return nil }
        let r = textView.selectedRange()
        let anchorAtEnd = textView.selectionAffinity == .upstream && r.length > 0
        let a = docPoint(r.location), b = docPoint(NSMaxRange(r))
        return anchorAtEnd ? DocSelection(anchor: b, focus: a) : DocSelection(anchor: a, focus: b)
    }
    func setSelection(_ s: DocSelection) {
        core.lastSelection = s
        let a = storageIndex(s.anchor), b = storageIndex(s.focus)
        textView.setSelectedRange(NSRange(location: min(a, b), length: abs(b - a)), affinity: b < a ? .upstream : .downstream, stillSelecting: false)
    }

    // MARK: the caret's line

    public func textViewDidChangeSelection(_ notification: Notification) {
        // A composition's marked text moves the selection: the IME's until it commits, never a redraw under it.
        guard !syncing, !composing, !textView.hasMarkedText() else { return }
        guard let s = docSelection() else { return }
        core.lastSelection = s
        if let e = core.editing, !(s.sameLine && s.anchor.line == e.q), !textView.pressing { core.cancelEdit(); redraw(keepSelection: true); return }
        if textView.pressing { return }
        selectionSettled()
    }

    /// The selection is the person's now (the mouse up, a key moved it): its line becomes the caret's, and tokens it
    /// touches open.
    func selectionSettled() {
        guard let s = docSelection() else { return }
        core.lastSelection = s
        if !s.sameLine { return }
        let ls = core.lines, i = s.anchor.line
        guard i < ls.count else { return }
        if rendered.maps[i].widget || core.lockedAt(ls, i) {
            if core.activeLine != nil { core.activeLine = nil; redraw(keepSelection: true) }
            return
        }
        if core.activeLine != i || openKey(i, s) != lastOpenKey {
            core.activeLine = i
            core.caret = CaretPlace(line: i, sel: (s.start.offset, s.end.offset), back: s.backward)
            redraw()
        }
        lastOpenKey = openKey(i, s)
    }
    var lastOpenKey = ""
    func openKey(_ i: Int, _ s: DocSelection) -> String {
        let ls = core.lines, p = core.parsed(ls)[i]
        if p.type == .img || Doc.isCode(p) || Doc.isFence(p) { return "\(i)" }
        let toks = Inline.tokensOf(p, ls[i])
        var acc = 0, out: [String] = []
        for (k, tok) in toks.enumerated() {
            let end = acc + tok.len
            let touched = tok.hasPrefix("@[") ? s.start.offset < end && s.end.offset > acc : s.start.offset <= end && s.end.offset >= acc
            if Inline.tokShown(tok).pre > 0 && touched { out.append(String(k)) }
            acc = end
        }
        return "\(i):" + out.joined(separator: ",")
    }

    /// Whether the app is the active one (focus going to another app is not leaving the line); a test stands in for it.
    var appActive: () -> Bool { get { appActiveHook ?? { NSApp.isActive } } set { appActiveHook = newValue } }
    func focusLeft() {
        // Switching to another app is not leaving the line; the keyboard going elsewhere in the window is.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.appActive(), let w = self.window, w.firstResponder !== self.textView else { return }
            if let fr = w.firstResponder as? NSView, fr.isDescendant(of: self.mentionMenu ?? NSView()) { return }
            self.core.cancelEdit()
            if self.core.activeLine != nil { self.core.activeLine = nil; self.redraw(keepSelection: true) }
            self.closeMention()
        }
    }

    // MARK: typing and keys

    func typed(_ text: String, replacing: NSRange?) {
        guard !readOnly else { return }
        byMouse = false
        var sel = docSelection() ?? DocSelection(line: 0, offset: 0)
        if let r = replacing, r.location != NSNotFound { sel = DocSelection(anchor: docPoint(r.location), focus: docPoint(NSMaxRange(r))) }
        core.insert(text, at: sel)
        redraw()
    }

    /// A key NSTextView turned into a command (deleteBackward:, insertNewline:, …), as editorKey reads it.
    func command(_ key: String, shift: Bool = false, cmd: Bool = false, alt: Bool = false, word: Bool = false, line: Bool = false) -> Bool {
        guard var s = docSelection() else { return false }
        byMouse = false
        if mention != nil, key == "Backspace", s.collapsed, upFromFolder(s.anchor.offset) { return true }
        if mention != nil, mentionKey(key, shift: shift) { return true }
        if key == "Escape" {
            if picker != nil || pop != nil { closePopups(); return true }
            if cards.repick != nil { cards.repick = nil; redraw(keepSelection: true); return true }
            if core.editing != nil { core.cancelEdit(); redraw(); return true }
            core.activeLine = nil
            redraw(keepSelection: true)
            window?.makeFirstResponder(nil)
            return true
        }
        // ⌥⌫ and ⌘⌫ delete as the system does: the word or the line before the caret, as one range.
        if (word || line) && s.collapsed {
            let ls = core.lines, cur = core.lineText(ls, s.anchor.line), at = s.anchor.offset
            var from = 0
            if word { var k = at; let u = Array(cur.utf16); while k > 0 && u[k - 1] == 32 { k -= 1 }; while k > 0 && u[k - 1] != 32 { k -= 1 }; from = k }
            if from < at { s = DocSelection(anchor: DocPoint(line: s.anchor.line, offset: from), focus: s.anchor) }
            if !s.collapsed { core.deleteSelection(s); redraw(); return true }
        }
        let used = core.key(KeyPress(key, shift: shift, cmd: cmd, alt: alt, composing: composing), sel: s)
        if !used && (key == "Backspace" || key == "Delete") && !readOnly {
            // A character, or a range on one line, as the text view would delete it.
            let ls = core.lines, i = s.anchor.line
            if !core.lockedAt(ls, i) {
                let cur = core.lineText(ls, i)
                var a = s.start.offset, b = s.end.offset
                if a == b { if key == "Backspace" { a = previousBoundary(cur, a) } else { b = nextBoundary(cur, b) } }
                if a != b { core.typeLine(i, cur.slice(0, a) + cur.slice(b), caret: a, bulk: s.start.offset != s.end.offset) }
            }
        }
        redraw()
        return true
    }

    func previousBoundary(_ s: String, _ at: Int) -> Int {
        let ns = s as NSString
        guard at > 0 else { return 0 }
        return ns.rangeOfComposedCharacterSequence(at: at - 1).location
    }
    func nextBoundary(_ s: String, _ at: Int) -> Int {
        let ns = s as NSString
        guard at < ns.length else { return ns.length }
        return NSMaxRange(ns.rangeOfComposedCharacterSequence(at: at))
    }

    /// Keys before NSTextView sees them: the @ menu's arrows, the formatting and undo shortcuts, find, a character beside a
    /// picture. → whether the key was used.
    func handleKeyDown(_ event: NSEvent) -> Bool {
        if !event.modifierFlags.intersection([.command, .control]).isEmpty || event.characters?.isEmpty == false { keyedAt = Date(); askHold = nil; settle = nil }
        let flags = event.modifierFlags, cmd = flags.contains(.command), shift = flags.contains(.shift)
        let chars = event.charactersIgnoringModifiers?.lowercased() ?? ""
        if picker != nil && event.keyCode != 53 { closePicker() }
        if mention != nil {
            switch event.keyCode {
            case 125: return mentionKey("ArrowDown", shift: false)
            case 126: return mentionKey("ArrowUp", shift: false)
            default: break
            }
        }
        if cmd && handlesFind && chars == "f" { openFind(); return true }
        if cmd && handlesFind && chars == "g" { findBar?.step(shift ? -1 : 1); return true }
        if cmd && ["b", "i", "k", "z"].contains(chars) { return command(chars, shift: shift, cmd: true) }
        if cmd && event.keyCode == 36 { return true }
        // A character typed beside a picture alone on its line: a line of its own.
        if !cmd, let s = docSelection(), s.collapsed, let ch = event.characters, ch.count == 1, ch.unicodeScalars.first!.value >= 32, ch.unicodeScalars.first!.value != 127,
           s.anchor.line < core.lines.count, core.parsed()[s.anchor.line].type == .img {
            core.key(KeyPress(ch), sel: s); redraw(); return true
        }
        return false
    }

    // MARK: paste, copy

    static let ownLines = NSPasteboard.PasteboardType("application/x-engelbart-lines")

    func paste(from pb: NSPasteboard) {
        guard !readOnly, let s = docSelection() else { return }
        let imageTypes: [(NSPasteboard.PasteboardType, String)] = [(.png, "image/png"), (NSPasteboard.PasteboardType("public.jpeg"), "image/jpeg"), (NSPasteboard.PasteboardType("com.compuserve.gif"), "image/gif"), (NSPasteboard.PasteboardType("org.webmproject.webp"), "image/webp"), (.tiff, "image/png")]
        for (type, mime) in imageTypes {
            guard let data = pb.data(forType: type) else { continue }
            let bytes = type == .tiff ? (NSBitmapImageRep(data: data)?.representation(using: .png, properties: [:]) ?? data) : data
            pasteImages([(bytes, mime)], at: s.start)
            return
        }
        let own = pb.string(forType: DocEditorView.ownLines)
        guard let plain = own ?? pb.string(forType: .string), !plain.isEmpty else { return }
        core.paste(plain, html: pb.string(forType: .html), own: own, at: s)
        redraw()
    }

    /// Pictures pasted or dropped: each saved by the host as `Attachment n` and put where it was let go.
    func pasteImages(_ items: [(Data, String)], at: DocPoint) {
        guard let host else { return }
        var where_ = at
        var extra = 0
        func next(_ k: Int) {
            guard k < items.count else { return }
            let label = core.nextAttachmentLabel(extra: extra)
            host.docEditor(self, pasteImage: items[k].0, mime: items[k].1, label: label) { [weak self] id in
                guard let self else { return }
                if let id { where_ = self.core.placeImage(id: id, label: label, at: where_); self.redraw() }
                next(k + 1)
            }
            extra = 0
        }
        next(0)
    }

    func copySelection(cut: Bool) -> Bool {
        guard let s = docSelection(), let out = core.copy(s) else { return false }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(out.markdown, forType: .string)
        pb.setString(out.html, forType: .html)
        if let own = out.own { pb.setString(own, forType: DocEditorView.ownLines) }
        if cut && !readOnly { core.deleteSelection(s); redraw() }
        return true
    }

    // MARK: clicks

    /// A press on something drawn that does something (a link, a mention, a checkbox, a citation): it does it, and the
    /// caret does not move there. → whether it was one.
    func click(at point: NSPoint, event: NSEvent) -> Bool {
        let container = textView.textContainer!
        let p = NSPoint(x: point.x - textView.textContainerOrigin.x, y: point.y - textView.textContainerOrigin.y)
        askHold = nil; settle = nil
        // The space under a card (gapAt): the caret on a line there, made first when it is not there.
        if let g = gapAt(point) { core.openGap(at: g.at, add: g.add); redraw(); window?.makeFirstResponder(textView); return true }
        // Below the last line: the caret at the end, or a line after a card.
        let used = layoutManager.usedRect(for: container)
        if p.y > used.maxY + 4 && !readOnly { core.focusEnd(); redraw(); window?.makeFirstResponder(textView); return true }
        var fraction: CGFloat = 0
        let g = layoutManager.glyphIndex(for: p, in: container, fractionOfDistanceThroughGlyph: &fraction)
        guard g < layoutManager.numberOfGlyphs else { return false }
        let ci = layoutManager.characterIndexForGlyph(at: g)
        guard let storage = textView.textStorage, ci < storage.length else { return false }
        // A todo's box, in its row's indent.
        if let mark = storage.attribute(.edMark, at: ci, effectiveRange: nil) as? MarkPaint, case .checkbox = mark.kind, p.x >= mark.x - 2 && p.x <= mark.x + mark.width + 4,
           let line = storage.attribute(.edLine, at: ci, effectiveRange: nil) as? Int, !readOnly {
            let frag = layoutManager.lineFragmentRect(forGlyphAt: g, effectiveRange: nil)
            if p.y >= frag.minY && p.y <= frag.maxY { core.toggleTodo(line); redraw(keepSelection: true); return true }
        }
        let rect = layoutManager.boundingRect(forGlyphRange: NSRange(location: g, length: 1), in: container).insetBy(dx: -4, dy: -4)
        guard rect.contains(p), let box = storage.attribute(.edAction, at: ci, effectiveRange: nil) as? ActionBox else { return false }
        let newTab = event.modifierFlags.contains(.command)
        perform(box.action, newTab: newTab)
        return true
    }

    func perform(_ action: EditorAction, newTab: Bool) {
        guard let host else { return }
        closePop()
        switch action {
        case .link(let href): host.docEditor(self, openLink: href, newTab: newTab, sections: nil)
        case .citation(let c): host.docEditor(self, openLink: c.href, newTab: newTab, sections: nil)
        case .citeMore: break
        case .attachment(let id):
            let src = id.hasPrefix("img:") ? String(id.dropFirst(4)) : id
            if let img = host.docEditor(self, image: src) { ImageViewer.show(img, over: window) }
        case .build(let q): if core.footBuild(q) { redraw() }
        case .resultAsk(let line, let agent): core.askResult(line, agent: agent); redraw()
        case .toggle(let i): core.toggleTodo(i); redraw(keepSelection: true)
        case .mention(let chip):
            switch chip.kind {
            case .made(let key): host.docEditor(self, openMade: key)
            case .zotero(let ref): host.docEditor(self, openZotero: ref, name: chip.name, newTab: newTab)
            case .file(let folderId, let rel): host.docEditor(self, openFile: folderId, rel: rel, name: chip.name, newTab: newTab)
            case .url(let address): host.docEditor(self, openLink: address, newTab: newTab, sections: nil)
            case .workspace(let id):
                if newTab { host.docEditor(self, openWorkspace: id) } else { host.docEditor(self, openBeside: "workspace", id: id, name: chip.name) }
            case .chat: break // an agent opens nothing
            case .library(let id):
                if let r = host.docEditorMentionable(self).first(where: { $0.row.id == id }) { openRow(r.row, newTab: newTab) }
            case .name(let name):
                let n = name.lowercased()
                if let r = host.docEditorMentionable(self).first(where: { $0.row.id != "bart" && $0.row.name.lowercased() == n }) { openRow(r.row, newTab: newTab) }
            }
        }
    }
    func openRow(_ row: LibRow, newTab: Bool) {
        guard let host, row.type != "chat" else { return }
        if Kind.isNote(row) && !newTab { host.docEditor(self, openBeside: "note", id: row.id, name: row.name) } else { host.docEditor(self, open: row) }
    }

    // MARK: overlays

    func paragraphRect(_ line: Int) -> NSRect? {
        guard line < rendered.maps.count else { return nil }
        let m = rendered.maps[line]
        let container = textView.textContainer!
        let len = m.range.length + (NSMaxRange(m.range) < (textView.textStorage?.length ?? 0) ? 1 : 0)
        var rect = NSRect.null
        if len > 0 {
            let g = layoutManager.glyphRange(forCharacterRange: NSRange(location: m.range.location, length: len), actualCharacterRange: nil)
            layoutManager.enumerateLineFragments(forGlyphRange: g) { r, _, _, _, _ in rect = rect.union(r) }
        } else { rect = layoutManager.extraLineFragmentRect }
        if rect.isNull { return nil }
        rect.origin.x = 0; rect.size.width = container.size.width
        return rect.offsetBy(dx: textView.textContainerOrigin.x, dy: textView.textContainerOrigin.y)
    }

    func placeOverlays() {
        overlays.forEach { $0.removeFromSuperview() }
        overlays.removeAll()
        guard host != nil else { return }
        let ls = core.lines
        for d in rendered.decos {
            guard let rect = paragraphRect(d.line) else { continue }
            let paraStyle = d.line < rendered.maps.count ? (textView.textStorage?.length ?? 0) > rendered.maps[d.line].range.location ? textView.textStorage?.attribute(.paragraphStyle, at: rendered.maps[d.line].range.location, effectiveRange: nil) as? NSParagraphStyle : nil : nil
            var view: NSView?
            var frame = rect
            switch d.deco {
            case .checkbox: continue
            case .chip(let label, let ready):
                let chip = ChipView(label: label, ready: ready)
                let size = chip.wanted
                frame = NSRect(x: rect.maxX - 10 - size.width, y: rect.maxY - 9 - 8 - size.height, width: size.width, height: size.height)
                chip.send.onClick = { [weak self] in self?.core.askInline(d.line); self?.redraw() }
                chip.onPick = { [weak self] v in self?.openPicker(line: d.line, from: v, kind: .line) }
                view = chip
            case .corner(let q, let whole, let label):
                let b = IconButton(Glyphs.chevronDown, tip: label, size: 16)
                b.color = Look.grey
                b.onClick = { [weak self] in
                    guard let self else { return }
                    if whole, let t = self.core.threads().first(where: { $0.turns.contains { $0.q == q } }) { self.core.toggleThread(t.titleLine) } else { self.core.collapseTurn(q) }
                    self.redraw()
                }
                frame = NSRect(x: rect.maxX - 16 - 22, y: rect.minY + (paraStyle?.paragraphSpacingBefore ?? 14) - 2, width: 28, height: 28)
                view = b
            case .foot(let q, let busy, _):
                let f = FootView(busy: busy)
                f.copy.onClick = { [weak self, weak f] in guard let self else { return }; self.host?.docEditor(self, copy: self.core.copyText(q)); f?.copied() }
                f.regen.onClick = { [weak self, weak f] in guard let self, let f else { return }; self.openPicker(line: q, from: f.regen, kind: .regen) }
                f.delete.onClick = { [weak self] in self?.core.deleteTurn(q); self?.redraw() }
                // A live card's Skip and @brainstorm's Wrap up; an @discover guide's Save all (n).
                let x = footExtras(q)
                if x.skip { let b = TextButton("Skip", size: 13); b.onClick = { [weak self] in self?.core.sendCard(q, how: "skip"); self?.redraw() }; f.add(b) }
                if x.wrap { let b = TextButton("Wrap up", size: 13); b.onClick = { [weak self] in self?.core.sendCard(q, how: "wrap"); self?.redraw() }; f.add(b) }
                if let label = x.saveAll { let b = TextButton(label, size: 13); b.isEnabled = label != "Saving…"; b.onClick = { [weak self] in self?.saveAllPapers(q) }; f.add(b) }
                frame = d.whole ? rect : NSRect(x: rect.minX, y: rect.maxY - (paraStyle?.paragraphSpacing ?? 58) + d.below, width: rect.width, height: 50)
                view = f
            case .pending(let id):
                let v = PendingView(progress: core.asks[id], waitLeft: core.waits[id]?.left, logOpen: openLogs.contains(id))
                v.follow = streamHeld[id] == nil
                v.heldTop = streamHeld[id]
                v.onScrolled = { [weak self] top, fromBottom in self?.streamHeld[id] = fromBottom > 40 ? top : nil }
                v.stop.onClick = { [weak self] in
                    guard let self else { return }
                    if self.core.waits[id] != nil { self.core.cancelWait(id) }
                    else if self.core.asks[id] != nil { self.host?.docEditor(self, stop: id) }
                    else if let i = self.core.lines.firstIndex(of: "bart~> \(id)") { self.core.removeLine(i) }
                    self.redraw()
                }
                v.steps?.onClick = { [weak self] in guard let self else { return }; if self.openLogs.contains(id) { self.openLogs.remove(id) } else { self.openLogs.insert(id) }; self.redraw(keepSelection: true) }
                view = v
            case .titleRow(let title, let when, let running):
                let v = TitleRowView(title: title, when: when, running: running)
                v.onExpand = { [weak self] in self?.core.toggleThread(d.line); self?.redraw() }
                v.onRename = { [weak self] t in self?.core.commitTitle(d.line, t); self?.redraw() }
                frame = NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: 42)
                view = v
            case .foldedRow(let q, let shown):
                let v = FoldedRowView(shown: shown, top: ls.indices.contains(q) && (core.threads().first { $0.from == q } != nil))
                v.onExpand = { [weak self] in self?.core.toggleFold(q); self?.redraw() }
                view = v
            case .build(let id):
                guard let host, let v = host.docEditor(self, buildView: id) else { continue }
                frame = rect.insetBy(dx: 0, dy: 6)
                view = v
            case .copyCode:
                let b = IconButton(Glyphs.copy, tip: "Copy")
                b.onClick = { [weak self, weak b] in
                    guard let self else { return }
                    let ls = self.core.lines, ps = self.core.parsed(ls)
                    guard d.line < ps.count, let block = ps[d.line].block else { return }
                    let text = (block.open + 1 < block.close ? Array(block.open + 1..<block.close) : []).map { ps[$0].type == .reply ? ps[$0].text : ls[$0] }.joined(separator: "\n")
                    self.host?.docEditor(self, copy: text)
                    b?.toolTip = "Copied"; b?.color = Look.grey; b?.needsDisplay = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { b?.toolTip = "Copy"; b?.color = Look.mid; b?.needsDisplay = true }
                }
                frame = NSRect(x: rect.maxX - 6 - 28 - 16, y: rect.minY + max(0, (rect.height - 28) / 2), width: 28, height: 28)
                view = b
            case .replyField(let from, let lead):
                let v = ReplyFieldView(lead: lead, text: core.followText[from] ?? ""); v.from = from
                v.onText = { [weak self] t in self?.core.followText[from] = t; self?.fieldMention(from: from, field: v.field) }
                v.onSend = { [weak self] in self?.core.sendFollow(from); self?.redraw() }
                v.onHeight = { [weak self] h in if abs(h - d.height) > 1 { self?.redraw(keepSelection: true) } }
                v.onKey = { [weak self, weak v] e in
                    guard let self, let v else { return false }
                    if self.mention?.field == from, e.keyCode == 51, v.field.selectedRange().length == 0, self.upFromFolder(v.field.selectedRange().location) { return true }
                    if self.mention?.field == from {
                        if e.keyCode == 125 { return self.mentionKey("ArrowDown", shift: false) }
                        if e.keyCode == 126 { return self.mentionKey("ArrowUp", shift: false) }
                        if e.keyCode == 36 || e.keyCode == 48 { return self.mentionKey("Enter", shift: false) }
                        if e.keyCode == 53 { return self.mentionKey("Escape", shift: false) }
                    }
                    if e.keyCode == 36 { if !e.modifierFlags.contains(.shift) { self.core.sendFollow(from); self.redraw() }; return true }
                    if e.keyCode == 53 { self.window?.makeFirstResponder(nil); _ = v; return true }
                    return false
                }
                frame = NSRect(x: rect.minX, y: rect.maxY - (paraStyle?.paragraphSpacing ?? (d.height + 8)) + d.below, width: rect.width, height: d.height)
                view = v
            case .more(let key, let open):
                let v = MoreView(open: open)
                v.button.onClick = { [weak self] in
                    guard let self else { return }
                    if open { self.moreOpen.remove(key) } else { self.moreOpen.insert(key) }
                    self.applyCuts(); self.redraw(keepSelection: true)
                }
                frame = NSRect(x: rect.minX, y: rect.maxY - (paraStyle?.paragraphSpacing ?? 26) + d.below, width: rect.width, height: d.height)
                if !open {
                    let fade = FadeView(frame: NSRect(x: rect.minX + 18, y: frame.minY - 56, width: rect.width - 34, height: 56))
                    textView.addSubview(fade); overlays.append(fade)
                }
                view = v
            case .sources(let q):
                let ls = core.lines
                guard let found = core.findTurn(ls, q) else { continue }
                let answer = Doc.turnText(ls, found.turn).answer
                let rows = host?.docEditorMentionable(self).map { $0.row } ?? []
                let v = SourcesView(sources: Cite.citationSources(answer, cites: Cite.citationNumbers([answer]), citeSource: { Cite.libraryName(rows, $0) }))
                v.onOpen = { [weak self] href in guard let self else { return }; self.host?.docEditor(self, openLink: href, newTab: false, sections: nil) }
                frame = NSRect(x: rect.minX, y: rect.maxY - (paraStyle?.paragraphSpacing ?? d.height) + d.below, width: rect.width, height: d.height)
                view = v
            case .chipNote(let text, let offset):
                guard d.line < rendered.maps.count else { continue }
                let at = rendered.maps[d.line].range.location + offset
                let g = layoutManager.glyphRange(forCharacterRange: NSRange(location: at, length: 1), actualCharacterRange: nil)
                let r = layoutManager.boundingRect(forGlyphRange: g, in: textView.textContainer!).offsetBy(dx: textView.textContainerOrigin.x, dy: textView.textContainerOrigin.y)
                let label = ChipNoteView(text: text)
                frame = NSRect(x: r.minX, y: r.maxY + 4, width: label.wanted.width, height: label.wanted.height)
                view = label
            case .card, .made, .creating, .paperMark, .sendDiscover:
                guard let (v, f) = cardsOverlay(d, rect: rect, spacing: paraStyle?.paragraphSpacing) else { continue }
                view = v; frame = f
            case .research(let state, let label):
                let v = ResearchView(state: state, level: label, canAct: core.hooks.ask != nil && !readOnly)
                v.action?.onClick = { [weak self] in
                    guard let self else { return }
                    if state == "ready" { self.core.startResearch(d.line) } else { self.core.restartResearch(d.line) }
                    self.redraw()
                }
                view = v
            }
            guard let v = view else { continue }
            v.frame = frame
            textView.addSubview(v)
            overlays.append(v)
        }
        placePictureHandles()
        // The hint on the document's last line while it is empty (props.emptyHint): drawn, never in the text.
        if let hint = emptyHint, ls.last?.isEmpty == true, let rect = paragraphRect(ls.count - 1) {
            let label = NSTextField(labelWithString: hint)
            label.font = Fonts.sans(Look.body); label.textColor = NSColor(hex: "#b5b5b5")
            label.frame = NSRect(x: rect.minX, y: rect.minY + max(0, (rect.height - 22) / 2), width: rect.width, height: 22)
            textView.addSubview(label); overlays.append(label)
        }
        // Top right of the page: every answer folded or unfolded at once, as plain words (2026-09-29).
        let items = compact || readOnly ? [] : core.foldable()
        if !items.isEmpty {
            let open = items.contains { !$0.folded }
            let b = TextButton(open ? "Collapse all" : "Expand all", size: 12.5, weight: 400)
            b.toolTip = open ? "Collapse every @bart answer" : "Expand every @bart answer"
            b.onClick = { [weak self] in self?.foldAll(open) }
            b.frame = NSRect(x: bounds.width - 22 - b.frame.width - 12, y: 8, width: b.frame.width + 12, height: 22)
            addSubview(b, positioned: .above, relativeTo: scroll); overlays.append(b)
        }
    }

    // MARK: Show more (applyClips)

    static let ANSWER_LINE_PX: CGFloat = 16 * 1.65
    static let CLIP_OLD = 6

    /// A turn's answer as one key: its question's and closing line's hashes, and which of the same question it is.
    func answerKey(_ ls: [String], _ turn: Turn) -> String {
        var nth = 0
        for j in 0..<turn.q where ls[j] == ls[turn.q] { nth += 1 }
        return "\(EditorText.hashLine(ls[turn.q])).\(EditorText.hashLine(ls[turn.foot >= 0 ? turn.foot : turn.to]))\(nth > 0 ? ".\(nth)" : "")"
    }

    /// The answers that may be cut: not a conversation's first, not its latest answered; never in a post-it.
    func cuttable() -> [(turn: Turn, key: String)] {
        guard !compact else { return [] }
        let ls = core.lines
        var out: [(Turn, String)] = []
        for t in core.threads(ls) where !core.collapsedOf(ls).contains(t.from) {
            let latest = t.turns.last { $0.answered && $0.pending == nil }?.q
            for (n, turn) in t.turns.enumerated() where n > 0 && turn.q != latest && turn.answered && turn.pending == nil && !turn.folded && turn.build == nil && !Doc.isResearch(core.parsed(ls)[turn.q]) {
                out.append((turn, answerKey(ls, turn)))
            }
        }
        return out
    }

    /// Turn → (key, open) for answers long enough to have a toggle.
    func moreKeys() -> [Int: (key: String, open: Bool)] {
        var out: [Int: (key: String, open: Bool)] = [:]
        for (turn, key) in cuttable() { if let m = measured[key], m >= 0 { out[turn.q] = (key, moreOpen.contains(key)) } }
        return out
    }

    func applyCuts() {
        clipFrom = [:]
        for (turn, key) in cuttable() { if let m = measured[key], m >= 0, !moreOpen.contains(key) { clipFrom[turn.q] = turn.from + m } }
    }

    /// Each answer not yet measured is measured as drawn whole: over (6 + 2) answer lines + 16px it is cut where its rows
    /// pass 14 + 6 lines. → whether the cuts changed (the editor is drawn again).
    func measureClips() -> Bool {
        guard !measuring else { return false }
        let width = textView.textContainer?.size.width ?? 0
        if width != measuredWidth {
            // Another width: every answer is measured again as drawn whole (its cut put back first).
            measured = [:]; measuredWidth = width
            if !clipFrom.isEmpty { clipFrom = [:]; redrawMeasured() }
        }
        let ls = core.lines
        var changed = false
        for (turn, key) in cuttable() where measured[key] == nil && clipFrom[turn.q] == nil {
            let last = (turn.foot >= 0 ? turn.foot : turn.to + 1) - 1
            guard turn.from <= last else { measured[key] = -1; continue }
            let rows = (turn.from...last).compactMap { j -> (Int, NSRect)? in paragraphRect(j).flatMap { $0.height > 0.5 ? (j, $0) : nil } }
            guard let first = rows.first else { measured[key] = -1; continue }
            let top = first.1.minY, bottom = rows.last!.1.maxY
            if bottom - top <= CGFloat(DocEditorView.CLIP_OLD + 2) * DocEditorView.ANSWER_LINE_PX + 16 { measured[key] = -1; continue }
            let cut = 14 + CGFloat(DocEditorView.CLIP_OLD) * DocEditorView.ANSWER_LINE_PX
            measured[key] = (rows.first { $0.1.minY - top >= cut }?.0 ?? last + 1) - turn.from
            changed = true
        }
        _ = ls
        guard changed else { return false }
        let was = clipFrom
        applyCuts()
        if was == clipFrom && !changed { return false }
        redrawMeasured()
        return true
    }
    /// Drawn again from inside a draw (measureClips runs in redraw, where `syncing` holds): the cuts in, no re-measuring.
    func redrawMeasured() {
        let was = syncing
        syncing = false; measuring = true
        redraw(keepSelection: true)
        measuring = false; syncing = was
    }

    // MARK: scrolling and places

    @objc func scrolled() {
        closePicker(); closePop()
        if let m = mention { mention = m; positionMenu() }
        viewTimer?.invalidate()
        viewTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in self?.reportView(now: false) }
        placeFindHighlights()
    }

    /// The first line on screen, how far its top is above the pane's top, a hash of its text (captureView).
    public func captureView() -> ViewPosition {
        let top = scroll.contentView.bounds.minY
        for m in rendered.maps where !m.widget || true {
            guard let r = paragraphRect(m.line), r.height > 0, r.maxY > top + 1 else { continue }
            return ViewPosition(top: Double(top.rounded()), line: m.line, offset: Double((top - r.minY).rounded()), hash: EditorText.hashLine(core.lines[m.line]))
        }
        return ViewPosition(top: Double(top.rounded()))
    }
    func reportView(now: Bool) {
        viewTimer?.invalidate(); viewTimer = nil
        guard let host, let scope = viewScope, !core.docKey.isEmpty else { return }
        host.docEditor(self, reportView: captureView(), scope: scope, key: core.docKey, now: now)
    }
    func restoreView() {
        guard let host, let scope = viewScope else { scrollTo(y: 0); return }
        guard let pos = host.docEditor(self, viewOf: scope, key: core.docKey) else { scrollTo(y: 0); return }
        settle = (core.docKey, pos, Date().addingTimeInterval(4))
        applyView(pos)
    }
    /// Lines added or taken away above it: the nearest line with the same text (its hash).
    public func applyView(_ pos: ViewPosition) {
        let ls = core.lines
        var i: Int? = nil
        if let line = pos.line {
            i = line < ls.count ? line : nil
            if let hash = pos.hash, i == nil || EditorText.hashLine(ls[i!]) != hash {
                for d in 0..<ls.count {
                    if line - d >= 0 && line - d < ls.count && EditorText.hashLine(ls[line - d]) == hash { i = line - d; break }
                    if line + d < ls.count && EditorText.hashLine(ls[line + d]) == hash { i = line + d; break }
                }
            }
        }
        if let i, let r = paragraphRect(i), r.height > 0 { scrollTo(y: r.minY + CGFloat(pos.offset ?? 0)) } else { scrollTo(y: CGFloat(pos.top)) }
    }
    func scrollTo(y: CGFloat) {
        scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, y)))
        scroll.reflectScrolledClipView(scroll.contentView)
    }
    func scrollToEnd() { textView.scrollToEndOfDocument(nil) }

    /// The Agent Viewer's click: line `i` in the middle of the pane, lit #fff1b8 for 2.4 s (`flash` false: no light). A
    /// line in a collapsed conversation expands it first and says false: the caller asks again once it is drawn.
    @discardableResult public func showLine(_ i: Int, flash: Bool = true) -> Bool {
        let ls = core.lines
        if core.collapsedOf(ls).contains(i), let t = core.threads().first(where: { $0.titleLine >= 0 && $0.folded && i >= $0.from && i <= $0.to }) {
            if !readOnly { core.toggleThread(t.titleLine); redraw() }
            return false
        }
        guard let r = paragraphRect(i) else { return false }
        let pane = scroll.contentSize.height
        scrollTo(y: r.minY - max(0, (pane - r.height) / 2))
        settle = (core.docKey, captureView(), Date().addingTimeInterval(1.5))
        if flash { flashLine = (i, Date().addingTimeInterval(2.4)); applyFlash(); DispatchQueue.main.asyncAfter(deadline: .now() + 2.45) { [weak self] in self?.applyFlash() } }
        return true
    }
    func applyFlash() {
        guard let storage = textView.textStorage else { return }
        layoutManager.removeTemporaryAttribute(.backgroundColor, forCharacterRange: NSRange(location: 0, length: storage.length))
        guard let f = flashLine, Date() < f.until, f.line < rendered.maps.count else { flashLine = nil; return }
        let m = rendered.maps[f.line]
        layoutManager.addTemporaryAttribute(.backgroundColor, value: Look.flash, forCharacterRange: m.range)
    }

    /// A citation clicked: line `i` brought to the middle of the pane and the quoted words lit up until the next press or key.
    @discardableResult public func showPassage(_ i: Int, find: String) -> Bool {
        let ls = core.lines
        if let found = core.threads().flatMap({ $0.turns }).first(where: { i >= $0.q && i <= $0.to }), found.folded, found.answered, found.pending == nil, !readOnly {
            core.toggleFold(found.q); redraw(); return false
        }
        guard showLine(i, flash: false) else { return false }
        let end = min(ls.count - 1, i + 8)
        guard i <= end else { return true }
        let maps = rendered.maps[i...end]
        let start = maps.first!.range.location, stop = NSMaxRange(maps.last!.range)
        let shown = (textView.string as NSString).substring(with: NSRange(location: start, length: stop - start))
        guard let hit = PassageText.matchPassage(shown, find, prefixes: true).first else { return showLine(i) }
        layoutManager.addTemporaryAttribute(.backgroundColor, value: NSColor(srgbRed: 0, green: 112 / 255, blue: 243 / 255, alpha: 0.4), forCharacterRange: NSRange(location: start + hit.start, length: hit.end - hit.start))
        passageLit = true
        return true
    }
    var passageLit = false

    // MARK: hover cards

    func hover(at point: NSPoint) {
        hoverMade(point)
        let container = textView.textContainer!
        let p = NSPoint(x: point.x - textView.textContainerOrigin.x, y: point.y - textView.textContainerOrigin.y)
        var f: CGFloat = 0
        let g = layoutManager.glyphIndex(for: p, in: container, fractionOfDistanceThroughGlyph: &f)
        guard g < layoutManager.numberOfGlyphs, let storage = textView.textStorage else { return }
        let ci = layoutManager.characterIndexForGlyph(at: g)
        let rect = layoutManager.boundingRect(forGlyphRange: NSRange(location: g, length: 1), in: container)
        guard ci < storage.length, rect.contains(p), let box = storage.attribute(.edAction, at: ci, effectiveRange: nil) as? ActionBox else { leaveHover(); return }
        let anchor = rect.offsetBy(dx: textView.textContainerOrigin.x, dy: textView.textContainerOrigin.y)
        switch box.action {
        case .mention(let chip):
            let rows = host?.docEditorMentionable(self) ?? []
            var found: EditorRow?
            switch chip.kind {
            case .library(let id): found = rows.first { $0.row.id == id }
            case .name(let n): found = rows.first { $0.row.name.lowercased() == n.lowercased() }
            case .chat: found = rows.first { $0.row.id == "bart" } ?? EditorRow(row: LibRow(id: "bart", name: "bart", type: "chat", summary: "Ask anything. Bart picks Chat, Brainstorm, Discover, Create or Build, then steps aside."), title: "Bart", facts: "picks, never answers")
            case .workspace: found = EditorRow(row: LibRow(id: "ws", name: chip.name, type: "workspace"), title: chip.name)
            default: found = nil
            }
            if let found { showPop(.item(found), anchor: anchor) }
        case .citation(let c):
            let source = Cite.citationSource(c) { a in Cite.libraryName(rows(), a) }
            showPop(.citation(Cite.citationCard(c, source: source)), anchor: anchor)
        default: leaveHover()
        }
        func rows() -> [LibRow] { (host?.docEditorMentionable(self) ?? []).map { $0.row } }
    }

    // MARK: drops

    /// The drag types the document takes: files, links, a page's HTML, sidebar rows (Mention.LIB_DRAG_TYPE).
    static let dropTypes: [NSPasteboard.PasteboardType] = [.fileURL, .URL, .html, .string, .png, .tiff, NSPasteboard.PasteboardType(Mention.LIB_DRAG_TYPE)]

    /// A drop on the document, read where it was let go (editorDrop/libDrop): sidebar rows write their mentions (and
    /// come into the workspace), pictures are pasted pictures, anything else goes to the host as library items.
    func drop(_ info: NSDraggingInfo, at point: NSPoint) -> Bool {
        guard !readOnly, let host else { return false }
        let pb = info.draggingPasteboard
        let p = NSPoint(x: point.x - textView.textContainerOrigin.x, y: point.y - textView.textContainerOrigin.y)
        let used = layoutManager.usedRect(for: textView.textContainer!)
        var at: DocPoint
        if p.y >= used.maxY { let ls = core.lines; at = DocPoint(line: ls.count - 1, offset: core.lineText(ls, ls.count - 1).len) }
        else { at = docPoint(layoutManager.characterIndex(for: p, in: textView.textContainer!, fractionOfDistanceBetweenInsertionPoints: nil)) }
        if let data = pb.data(forType: NSPasteboard.PasteboardType(Mention.LIB_DRAG_TYPE)), let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            let known = host.docEditorMentionable(self)
            let rows: [LibRow] = list.compactMap { o in
                guard let id = o["id"].map({ "\($0)" }), let name = o["name"] as? String else { return nil }
                return known.first { $0.row.id == id }?.row ?? LibRow(id: id, name: name, type: o["type"] as? String ?? "", path: o["path"] as? String, folderPath: o["folder_path"] as? String, url: o["url"] as? String)
            }
            guard !rows.isEmpty else { return false }
            core.placeDropped(rows.map { Mention.rowMention($0) }.joined(separator: " "), at: at)
            for r in rows { host.docEditor(self, picked: Mention.menuItem(r)) }
            redraw(); window?.makeFirstResponder(textView)
            return true
        }
        let urls = (pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
        var files: [Drop.Item] = urls.map { .path($0.path) }
        if files.isEmpty, let png = pb.data(forType: .png) { files = [.bytes(png, mime: "image/png", name: nil)] }
        let items = Drop.readDrop(files: files, uriList: pb.string(forType: .URL) ?? pb.string(forType: .string).flatMap { Rx(#"^https?:\/\/\S+$"#, "i").test($0.trimmed) ? $0 : nil }, html: pb.string(forType: .html))
        // Let go on a Zotero item's chip: a file becomes its pdf (MATH-65 build 4).
        let ci = layoutManager.characterIndex(for: p, in: textView.textContainer!, fractionOfDistanceBetweenInsertionPoints: nil)
        if ci < (textView.textStorage?.length ?? 0), let box = textView.textStorage?.attribute(.edAction, at: ci, effectiveRange: nil) as? ActionBox,
           case .mention(let chip) = box.action, case .zotero(let ref) = chip.kind {
            let paths = items.compactMap { if case .path(let x) = $0 { return x }; return nil }
            if let file = paths.first(where: { $0.lowercased().hasSuffix(".pdf") }) ?? paths.first { host.docEditor(self, dropOnZotero: ref, name: chip.name, file: file); return true }
        }
        let pictures = items.filter { Drop.isPastable($0) }
        let rest = items.filter { !Drop.isPastable($0) }
        let images: [(Data, String)] = pictures.compactMap {
            switch $0 {
            case .bytes(let d, let mime, _): return (d, mime)
            case .path(let path):
                guard let d = FileManager.default.contents(atPath: path) else { return nil }
                let ext = (path as NSString).pathExtension.lowercased()
                return (d, ext == "jpg" || ext == "jpeg" ? "image/jpeg" : "image/\(ext)")
            default: return nil
            }
        }
        if !images.isEmpty { pasteImages(images, at: at) }
        if !rest.isEmpty { host.docEditor(self, dropItems: rest) }
        return !items.isEmpty
    }

    /// A post-it's editor is as tall as its lines; a page's text has about half a window under its last line (2026-09-22).
    func sizeToContent() {
        guard let container = textView.textContainer else { return }
        let used = layoutManager.usedRect(for: container).height + (layoutManager.extraLineFragmentRect.height)
        textView.bottomExtra = compact ? 0 : max(120, scroll.contentSize.height / 2 - 40)
        if compact { textView.bottomExtra = 2 }
        contentHeight = used + textView.textContainerInset.height * (compact ? 0 : 1) + textView.bottomExtra
        textView.setFrameSize(NSSize(width: textView.frame.width, height: max(compact ? 28 : scroll.contentSize.height, contentHeight)))
        for a in rendered.maps.indices where core.asks.isEmpty && a < 0 { _ = a }
        let alive = Set(core.asks.keys)
        streamHeld = streamHeld.filter { alive.contains($0.key) }
    }

    public override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        textView.registerForDraggedTypes(DocEditorView.dropTypes)
        if window != nil { redraw(keepSelection: true) }
    }
}
