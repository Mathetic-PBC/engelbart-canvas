import AppKit
import EngelbartUI
import EngelbartDoc
import EngelbartEditor

/// One document of the middle column (workspace/DocPane.jsx, MATH-23): its title, the notice when another window saved
/// over edits here, and its editor. Pane 0 is the document in front, with the footer's Copy, Build and Clear; pane 1 is a
/// note or a workspace's document opened beside it, with a × in its header instead.
final class DocPaneView: FillView, NSTextFieldDelegate {
    let index: Int
    let editor = DocEditorView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
    let titleField = TitleField()
    var closeButton: FlatButton?
    let conflictBox = FillView()
    let keepButton: FlatButton
    let takeButton: FlatButton
    let conflictText = makeLabel("Saved in another window while you were editing.", font: Fonts.sans(12.5), color: Look.mut)
    let emptyBox = FlippedView()
    let opening = makeLabel("Opening…", font: Fonts.sans(13), color: Look.fnt)
    let footer = FillView()
    var footerButtons: [FlatButton] = []
    var walkCard: NSView? { didSet { oldValue?.removeFromSuperview(); if let walkCard { addSubview(walkCard) }; needsLayout = true } }
    var emptyView: NSView? { didSet { oldValue?.removeFromSuperview(); if let emptyView { emptyBox.addSubview(emptyView) }; needsLayout = true } }

    /// What the title shows (an untitled name is its hint, not its value).
    private(set) var title = ""
    var readOnlyTitle = false
    var onRename: ((String) -> Void)?
    var onKeepMine: (() -> Void)?
    var onTakeTheirs: (() -> Void)?
    var showsEditor = false { didSet { editor.isHidden = !showsEditor; titleField.isHidden = !showsEditor; emptyBox.isHidden = showsEditor; needsLayout = true } }
    var conflict = false { didSet { conflictBox.isHidden = !conflict } }
    var hasFooter = false { didSet { footer.isHidden = !hasFooter; needsLayout = true } }

    init(index: Int, onClose: (() -> Void)?) {
        self.index = index
        keepButton = FlatButton(.text("Keep mine", font: Fonts.sans(12.5, weight: 500)), color: Look.ink, id: "conflict-keep", tip: "Save your version over theirs")
        takeButton = FlatButton(.text("Take theirs", font: Fonts.sans(12.5)), color: Look.fnt, hoverColor: Look.ink, id: "conflict-take", tip: "Show their version and drop your unsaved edits here")
        super.init(frame: .zero)
        fill = .white
        setAccessibilityIdentifier("doc-pane=\(index)")
        addSubview(editor)
        titleField.delegate = self
        titleField.setAccessibilityIdentifier("doc-title")
        addSubview(titleField)
        if let onClose {
            let x = FlatButton(.text("×", font: Fonts.sans(18)), color: Look.fnt, hoverColor: Look.ink, hoverFill: Look.xHover, radius: 13, id: "pane-close=\(index)", tip: "Close", action: onClose)
            addSubview(x); closeButton = x
        }
        emptyBox.addSubview(opening)
        addSubview(emptyBox)
        // the notice: white card, 1px #eaeaea, radius 8, shadow 0 4 14 #0000000f, over the document (data-overlay)
        conflictBox.fill = .white
        conflictBox.corners = (8, 8, 8, 8)
        conflictBox.ring = Look.line
        conflictBox.wantsLayer = true
        conflictBox.shadow = { let s = NSShadow(); s.shadowColor = NSColor.black.withAlphaComponent(0x0f / 255); s.shadowBlurRadius = 14; s.shadowOffset = NSSize(width: 0, height: -4); return s }()
        conflictBox.setAccessibilityIdentifier("doc-conflict")
        conflictBox.setAccessibilityRole(.group)
        keepButton.action = { [weak self] in self?.onKeepMine?() }
        takeButton.action = { [weak self] in self?.onTakeTheirs?() }
        keepButton.padding = NSEdgeInsets(top: 3, left: 6, bottom: 3, right: 6); takeButton.padding = keepButton.padding
        for v in [conflictText, keepButton, takeButton] as [NSView] { conflictBox.addSubview(v) }
        conflictBox.isHidden = true
        addSubview(conflictBox)
        footer.fill = .white
        footer.isHidden = true
        footer.setAccessibilityIdentifier("doc-footer")
        addSubview(footer)
        showsEditor = false
    }
    required init?(coder: NSCoder) { fatalError() }

    func setTitle(_ name: String, readOnly: Bool) {
        readOnlyTitle = readOnly
        titleField.isEditable = !readOnly
        let shown = Names.isUntitled(name) ? "" : name
        title = name
        titleField.placeholderString = Names.isUntitled(name) ? name : "Untitled"
        if titleField.currentEditor() == nil && titleField.stringValue != shown { titleField.stringValue = shown }
    }

    /// The footer's buttons: Copy (Build, Clear) or Restore.
    func setFooter(_ buttons: [FlatButton]) {
        for b in footerButtons where !buttons.contains(where: { $0 === b }) { b.removeFromSuperview() }
        for b in buttons where b.superview !== footer { footer.addSubview(b) }
        footerButtons = buttons
        needsLayout = true
    }

    /// The editor's column, as Look.column places it: the title, the walk card and the footer keep to it.
    var column: (x: CGFloat, width: CGFloat) {
        let w = bounds.width
        let col = EditorLook.column(for: w)
        return (max(0, (w - col) / 2).rounded(), col)
    }
    static let titleTop: CGFloat = 28
    static let titleHeight: CGFloat = 30 // 22px / 1.35

    override func layout() {
        super.layout()
        let col = column
        let footerH: CGFloat = hasFooter ? 45 : 0
        footer.frame = CGRect(x: 0, y: bounds.height - footerH, width: bounds.width, height: footerH)
        var x = col.x - 6 // FOOT_BUTTON's margin-left -6 on the first
        for b in footerButtons {
            let s = b.intrinsicContentSize
            b.frame = CGRect(x: x, y: 1 + ((44 - s.height) / 2).rounded(), width: s.width, height: s.height)
            x += s.width + 4
        }
        let close: CGFloat = closeButton == nil ? 0 : 34
        titleField.frame = CGRect(x: col.x, y: Self.titleTop, width: max(0, col.width - close), height: Self.titleHeight)
        closeButton?.frame = CGRect(x: col.x + col.width - 26, y: Self.titleTop + 2, width: 26, height: 26)
        var top = Self.titleTop + Self.titleHeight
        if let card = walkCard {
            let h = card.fittingSize.height
            card.frame = CGRect(x: col.x, y: top + 12, width: col.width, height: h)
            top += 12 + h
        }
        // The editor's own top inset (28 + 18) sits under the title row: its text starts 18 below what is above it.
        let editorTop = max(0, top - 28)
        editor.frame = CGRect(x: 0, y: editorTop, width: bounds.width, height: max(0, bounds.height - footerH - editorTop))
        emptyBox.frame = CGRect(x: 0, y: 0, width: bounds.width, height: bounds.height - footerH)
        if let emptyView {
            let s = emptyView.fittingSize
            let w = min(s.width, bounds.width - 80)
            emptyView.frame = CGRect(x: ((bounds.width - w) / 2).rounded(), y: ((emptyBox.bounds.height - s.height) / 2).rounded(), width: w, height: s.height)
            opening.isHidden = true
        } else {
            opening.isHidden = false
            opening.sizeToFit()
            opening.frame.origin = NSPoint(x: ((bounds.width - opening.frame.width) / 2).rounded(), y: ((emptyBox.bounds.height - opening.frame.height) / 2).rounded())
        }
        // the notice: top 10, right 16, padding 5 6 5 12, at most the pane less 32
        conflictText.sizeToFit()
        let ks = keepButton.intrinsicContentSize, ts = takeButton.intrinsicContentSize
        let w = min(bounds.width - 32, 12 + conflictText.frame.width + 6 + ks.width + 4 + ts.width + 6)
        let h: CGFloat = 5 + max(ks.height, conflictText.frame.height) + 5
        conflictBox.frame = CGRect(x: bounds.width - 16 - w, y: 10, width: w, height: h)
        conflictText.frame.origin = NSPoint(x: 12, y: ((h - conflictText.frame.height) / 2).rounded())
        keepButton.frame = CGRect(x: 12 + conflictText.frame.width + 6, y: ((h - ks.height) / 2).rounded(), width: ks.width, height: ks.height)
        takeButton.frame = CGRect(x: keepButton.frame.maxX + 4, y: keepButton.frame.minY, width: ts.width, height: ts.height)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        // the footer's border-top 1px #eaeaea (the CSS has it)
        if hasFooter { Look.line.setFill(); CGRect(x: 0, y: footer.frame.minY, width: bounds.width, height: 1).fill() }
        // pane 1's left rule (MATH-23: 1px #eaeaea)
        if index > 0 { Look.line.setFill(); CGRect(x: 0, y: 0, width: 1, height: bounds.height).fill() }
    }

    // MARK: the title (DocPane.jsx): a draft while typed, named on Enter or when the caret leaves; a title is a file name

    func controlTextDidChange(_ obj: Notification) {
        let v = titleField.stringValue
        let clean = v.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: "\\", with: "-")
        if clean != v { titleField.stringValue = clean }
    }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            // Enter names the document and drops the caret into it.
            commit()
            window?.makeFirstResponder(nil)
            editor.focusStart()
            return true
        }
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            // Escape leaves the title, and that is all it does (marked as used).
            window?.makeFirstResponder(nil)
            return true
        }
        return false
    }
    func controlTextDidEndEditing(_ obj: Notification) { commit() }
    func commit() {
        let next = titleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let shown = Names.isUntitled(title) ? "" : title
        if next.isEmpty || next == title || readOnlyTitle || onRename == nil { titleField.stringValue = shown; return }
        onRename?(next)
    }
    func focusTitle() { window?.makeFirstResponder(titleField) }
}

/// The title field: 500 22px/1.35, -0.3 tracking, ink; borderless.
final class TitleField: NSTextField {
    init() {
        super.init(frame: .zero)
        isBordered = false
        drawsBackground = false
        focusRingType = .none
        font = Fonts.sans(22, weight: 500)
        textColor = Look.ink
        isEditable = true
        isSelectable = true
        lineBreakMode = .byTruncatingTail
        cell?.usesSingleLineMode = true
        setAccessibilityLabel("Title")
    }
    required init?(coder: NSCoder) { fatalError() }
    override var placeholderString: String? {
        didSet {
            placeholderAttributedString = NSAttributedString(string: placeholderString ?? "", attributes: [.font: Fonts.sans(22, weight: 500), .foregroundColor: Look.fnt, .kern: -0.3])
        }
    }
}

/// The editor's column rule (Editor Renderer Look.column, DocEditor DOC_COLUMN): padding clamp(12, 4%, 40) each side, then
/// 65ch at most less clamp(0, 3%, 24) each side.
enum EditorLook {
    static func column(for width: CGFloat) -> CGFloat {
        let ch = ("0" as NSString).size(withAttributes: [.font: Fonts.sans(17)]).width
        let padding = min(max(12, width * 0.04), 40) * 2
        let inner = width - padding
        return max(120, min(65 * ch, inner - 2 * min(max(0, inner * 0.03), 24)))
    }
}
