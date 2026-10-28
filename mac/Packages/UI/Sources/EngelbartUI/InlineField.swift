import AppKit
import SwiftUI

/// What an inline field does with a key or with losing focus (ui/InlineField.jsx), kept apart from the view so it can be
/// tested: Enter commits the trimmed text (an empty one cancels), Escape cancels, leaving the field commits.
public enum InlineFieldOutcome: Equatable, Sendable {
    case commit(String)
    case cancel
    case none

    public static func enter(_ text: String) -> InlineFieldOutcome {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? .cancel : .commit(trimmed)
    }
    public static let escape: InlineFieldOutcome = .cancel
    /// Leaving the field is a commit, as Enter (onBlur={commit}).
    public static func blur(_ text: String) -> InlineFieldOutcome { enter(text) }
}

/// A DS field (tinted box, its border strong while focused) that commits on Enter and cancels on Escape. It takes focus,
/// with everything selected, the moment it is in a window (Electron could not inside a panel's first frame). Shared with
/// the editor: it builds its own fields on this one.
public struct InlineField: View {
    let placeholder: String
    let initial: String
    let width: CGFloat?
    let autoFocus: Bool
    let onCommit: (String) -> Void
    let onCancel: (() -> Void)?
    @State private var focused = false

    public init(placeholder: String = "", initial: String = "", width: CGFloat? = 260, autoFocus: Bool = true,
                onCommit: @escaping (String) -> Void, onCancel: (() -> Void)? = nil) {
        self.placeholder = placeholder; self.initial = initial; self.width = width; self.autoFocus = autoFocus
        self.onCommit = onCommit; self.onCancel = onCancel
    }

    public var body: some View {
        InlineTextField(placeholder: placeholder, initial: initial, autoFocus: autoFocus, focused: $focused) { outcome in
            switch outcome {
            case .commit(let text): onCommit(text)
            case .cancel: onCancel?()
            case .none: break
            }
        }
        .frame(height: 14 * 1.4)
        .padding(EdgeInsets(top: 10, leading: 13, bottom: 10, trailing: 13)) // 9×12 + the 1px border
        .frame(width: width)
        .background(RoundedRectangle(cornerRadius: Radius.sm).fill(Color(Palette.tint)))
        .hoverBorder(radius: Radius.sm, rest: Palette.bd, focused: focused) // .focus-bd2
    }
}

/// The NSTextField under InlineField: no bezel, 14px ink, no spelling check, italic grey placeholder.
public struct InlineTextField: NSViewRepresentable {
    let placeholder: String
    let initial: String
    let autoFocus: Bool
    @Binding var focused: Bool
    let onOutcome: (InlineFieldOutcome) -> Void
    var font: NSFont = Fonts.sans(14)
    var placeholderItalic = true

    public init(placeholder: String, initial: String, autoFocus: Bool, focused: Binding<Bool>, font: NSFont = Fonts.sans(14),
                placeholderItalic: Bool = true, onOutcome: @escaping (InlineFieldOutcome) -> Void) {
        self.placeholder = placeholder; self.initial = initial; self.autoFocus = autoFocus; self._focused = focused
        self.font = font; self.placeholderItalic = placeholderItalic; self.onOutcome = onOutcome
    }

    public func makeCoordinator() -> Coordinator { Coordinator(self) }

    public func makeNSView(context: Context) -> FocusingTextField {
        let field = FocusingTextField()
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = font
        field.textColor = Palette.ink
        field.stringValue = initial
        field.lineBreakMode = .byTruncatingTail
        field.cell?.isScrollable = true
        field.cell?.wraps = false
        let placeholderFont = placeholderItalic ? NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) : font
        field.placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [.foregroundColor: Palette.fnt, .font: placeholderFont])
        field.delegate = context.coordinator
        field.focusOnAppear = autoFocus
        field.onFocusChange = { on in DispatchQueue.main.async { self.focused = on } }
        return field
    }

    public func updateNSView(_ nsView: FocusingTextField, context: Context) {
        context.coordinator.parent = self
    }

    public final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: InlineTextField
        var finished = false
        init(_ parent: InlineTextField) { self.parent = parent }

        public func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            if selector == #selector(NSResponder.insertNewline(_:)) {
                finish(.enter(control.stringValue)); return true
            }
            if selector == #selector(NSResponder.cancelOperation(_:)) {
                finish(.escape); return true
            }
            return false
        }

        public func controlTextDidEndEditing(_ obj: Notification) {
            guard let field = obj.object as? NSTextField else { return }
            finish(.blur(field.stringValue))
        }

        public func controlTextDidChange(_ obj: Notification) {
            // Spelling stays off (spellCheck={false}).
            if let editor = (obj.object as? NSTextField)?.currentEditor() as? NSTextView {
                editor.isContinuousSpellCheckingEnabled = false
                editor.isAutomaticSpellingCorrectionEnabled = false
            }
        }

        private func finish(_ outcome: InlineFieldOutcome) {
            guard !finished else { return }
            finished = true
            parent.onOutcome(outcome)
        }
    }
}

/// An NSTextField that becomes first responder, with its text selected, as soon as it is in a window, and says when it
/// gains or loses focus.
public final class FocusingTextField: NSTextField {
    public var focusOnAppear = false
    public var onFocusChange: ((Bool) -> Void)?

    public override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard focusOnAppear, let window else { return }
        focusOnAppear = false
        if window.makeFirstResponder(self) { currentEditor()?.selectAll(nil) }
    }

    public override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { onFocusChange?(true) }
        return ok
    }

    public override func textDidEndEditing(_ notification: Notification) {
        super.textDidEndEditing(notification)
        onFocusChange?(false)
    }
}
