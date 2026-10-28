import AppKit
import EngelbartUI
import SwiftTerm

/// One session's transcript: a SwiftTerm view configured as sessions.js configured xterm, with the pane's locked mode.
///
/// While the pane's own box is the input (the shell is idle), the transcript never holds the keys and shows no cursor
/// (the pane moves focus straight back to the box), a press on empty space starts nothing and clears the selection, and
/// only a drag that begins on printed text selects (memory note 2026-09-20, sessions.js `textUnder`).
///
/// Electron → native: xterm.js + the WebGL addon → SwiftTerm with its Metal renderer (CoreGraphics when Metal is not
/// there, as the DOM renderer was xterm's fallback); xterm's smoothScrollDuration → macOS precise scrolling.
public final class TranscriptView: TerminalView {
    /// The box is the input: see the type's comment.
    public var locked = false {
        didSet { if locked != oldValue { updateCaret() } }
    }
    /// A press on the locked transcript: the pane gives the box the keys.
    var onLockedPress: (() -> Void)?
    /// Text copied from a PDF loses its page layout before it reaches the program (MATH-24; the host's pdfText).
    var pasteTransform: ((String) -> String)?
    private var metalTried = false
    private(set) var hasKeys = false

    init(cols: Int, rows: Int, fontSize: CGFloat) {
        let options = TerminalOptions(cols: cols, rows: rows, cursorStyle: .blinkBar, scrollback: TerminalTheme.scrollback)
        super.init(frame: .zero, font: TerminalTheme.font(size: fontSize), options: options)
        nativeBackgroundColor = TerminalTheme.background
        nativeForegroundColor = TerminalTheme.foreground
        installColors(TerminalTheme.ansiColors)
        selectedTextBackgroundColor = TerminalTheme.selectionBackground
        selectedTextForegroundColor = TerminalTheme.selectionForeground
        caretTextColor = TerminalTheme.cursorAccent
        lineSpacing = TerminalTheme.lineHeight
        minimumContrastRatio = TerminalTheme.minimumContrastRatio
        optionAsMetaKey = true // macOptionIsMeta
        scrollSensitivity = TerminalTheme.scrollSensitivity
        linkReporting = .implicit
        linkHighlightMode = .hover // xterm's web links open on a plain click
        bellStyle = .none
        updateCaret()
    }

    public required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// The cursor shows only while the transcript has the keys (cursorInactiveStyle: 'none').
    func setHasKeys(_ value: Bool) {
        hasKeys = value
        updateCaret()
    }

    private func updateCaret() {
        caretColor = hasKeys && !locked ? TerminalTheme.cursor : .clear
    }

    func applyFontSize(_ size: CGFloat) {
        font = TerminalTheme.font(size: size)
    }

    public override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // The GPU renderer is what makes scrolling a long transcript smooth; CoreGraphics stays the fallback.
        if window != nil && !metalTried {
            metalTried = true
            try? setUseMetal(true)
        }
    }

    // MARK: pointer

    /// Whether `point` (view coordinates) is over a printed character, not blank space or an empty row.
    func textUnder(_ point: NSPoint) -> Bool {
        let dims = terminalDimensions
        guard dims.cols > 0, dims.rows > 0 else { return false }
        let grid = getOptimalFrameSize()
        let cellWidth = grid.width / CGFloat(dims.cols)
        let cellHeight = grid.height / CGFloat(dims.rows)
        guard cellWidth > 0, cellHeight > 0 else { return false }
        let fromTop = bounds.height - point.y
        guard point.x >= 0, fromTop >= 0 else { return false }
        let col = Int(point.x / cellWidth)
        let row = Int(fromTop / cellHeight)
        guard col < dims.cols, row < dims.rows else { return false }
        guard let line = visibleRowsText(row..<(row + 1)).first else { return false }
        var trimmed = line
        while let last = trimmed.last, last == " " || last == "\u{a0}" { trimmed.removeLast() } // translateToString(true)
        return col < trimmed.count
    }

    public override func mouseDown(with event: NSEvent) {
        if locked && !textUnder(convert(event.locationInWindow, from: nil)) {
            selectNone()
            onLockedPress?()
            return
        }
        super.mouseDown(with: event)
        if locked { onLockedPress?() }
    }

    /// rightClickSelectsWord: the word under the pointer is selected, as a double click would (only when the program
    /// does not take the mouse itself).
    public override func rightMouseDown(with event: NSEvent) {
        if currentMouseMode == .off,
           let down = NSEvent.mouseEvent(with: .leftMouseDown, location: event.locationInWindow, modifierFlags: [], timestamp: event.timestamp,
                                         windowNumber: event.windowNumber, context: nil, eventNumber: 0, clickCount: 2, pressure: 1),
           let up = NSEvent.mouseEvent(with: .leftMouseUp, location: event.locationInWindow, modifierFlags: [], timestamp: event.timestamp,
                                       windowNumber: event.windowNumber, context: nil, eventNumber: 0, clickCount: 2, pressure: 0) {
            super.mouseDown(with: down)
            super.mouseUp(with: up)
        }
        super.rightMouseDown(with: event)
    }

    // MARK: paste

    /// A paste that pdfText changes goes in as xterm's paste would: newlines as CR, bracketed when the program asked.
    public override func paste(_ sender: Any) {
        let raw = (NSPasteboard.general.string(forType: .string) ?? "").replacingOccurrences(of: "\r", with: "")
        guard !raw.isEmpty, let transform = pasteTransform else { super.paste(sender); return }
        let text = transform(raw)
        guard text != raw else { super.paste(sender); return }
        var prepared = text.replacingOccurrences(of: "\r\n", with: "\r").replacingOccurrences(of: "\n", with: "\r")
        if terminalStateSnapshot().bracketedPasteMode { prepared = "\u{1b}[200~" + prepared + "\u{1b}[201~" }
        send(data: Array(prepared.utf8)[...])
    }
}
