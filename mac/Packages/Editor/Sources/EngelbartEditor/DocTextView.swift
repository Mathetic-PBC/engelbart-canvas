import AppKit
import EngelbartDoc

// The NSTextView the document is typed in. It never changes its own text: every key, every typed character, a paste, a
// cut goes to DocEditorView, which edits the model (EditorCore) and draws it again. What it keeps of NSTextView is the
// caret, the selection, IME composition (marked text), scrolling and accessibility.

final class DocTextView: NSTextView {
    weak var editor: DocEditorView?
    /// A mouse button is down: the selection is only noted, the line becomes the caret's once it comes up.
    var pressing = false

    override func keyDown(with event: NSEvent) {
        if let editor, editor.handleKeyDown(event) { return }
        super.keyDown(with: event)
    }

    override func insertText(_ string: Any, replacementRange: NSRange) {
        let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        if hasMarkedText() {
            // The composition is the IME's until it commits: its marked text leaves the storage, the commit goes to the model.
            let marked = markedRange()
            unmarkText()
            if marked.location != NSNotFound, let storage = textStorage, NSMaxRange(marked) <= storage.length {
                storage.replaceCharacters(in: marked, with: "")
                setSelectedRange(NSRange(location: marked.location, length: 0))
            }
        }
        editor?.typed(text, replacing: replacementRange.location == NSNotFound ? nil : replacementRange)
    }

    override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        editor?.composing = true
        super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
    }
    override func unmarkText() { super.unmarkText(); editor?.composing = false }

    override func deleteBackward(_ sender: Any?) { _ = editor?.command("Backspace") }
    override func deleteForward(_ sender: Any?) { _ = editor?.command("Delete") }
    override func deleteWordBackward(_ sender: Any?) { _ = editor?.command("Backspace", alt: true, word: true) }
    override func deleteToBeginningOfLine(_ sender: Any?) { _ = editor?.command("Backspace", cmd: true, line: true) }
    override func insertNewline(_ sender: Any?) { _ = editor?.command("Enter") }
    override func insertLineBreak(_ sender: Any?) { _ = editor?.command("Enter", shift: true) }
    override func insertTab(_ sender: Any?) { _ = editor?.command("Tab") }
    override func insertBacktab(_ sender: Any?) { _ = editor?.command("Tab", shift: true) }
    override func cancelOperation(_ sender: Any?) { _ = editor?.command("Escape") }

    override func paste(_ sender: Any?) { editor?.paste(from: .general) }
    override func pasteAsPlainText(_ sender: Any?) { editor?.paste(from: .general) }
    override func copy(_ sender: Any?) { if editor?.copySelection(cut: false) != true { super.copy(sender) } }
    override func cut(_ sender: Any?) { _ = editor?.copySelection(cut: true) }

    override func shouldChangeText(in affectedCharRange: NSRange, replacementString: String?) -> Bool {
        // Marked text (a composition) is the only change the text view makes itself.
        hasMarkedText() || editor?.composing == true
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let editor, editor.click(at: point, event: event) { return }
        editor?.byMouse = true
        pressing = true
        super.mouseDown(with: event)
        pressing = false
        editor?.selectionSettled()
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        editor?.hover(at: convert(event.locationInWindow, from: nil))
    }

    // Nothing dropped is the text view's to place (MATH-19): the editor reads the drop and puts it where it was let go.
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { editor?.readOnly == true ? [] : .copy }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { editor?.readOnly == true ? [] : .copy }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let editor else { return false }
        return editor.drop(sender, at: convert(sender.draggingLocation, from: nil))
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { editor?.focusLeft() }
        return ok
    }

    override func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(undo(_:)) || menuItem.action == #selector(redo(_:)) { return true }
        return super.validateMenuItem(menuItem)
    }
    @objc func undo(_ sender: Any?) { _ = editor?.command("z", cmd: true) }
    @objc func redo(_ sender: Any?) { _ = editor?.command("z", shift: true, cmd: true) }
}
