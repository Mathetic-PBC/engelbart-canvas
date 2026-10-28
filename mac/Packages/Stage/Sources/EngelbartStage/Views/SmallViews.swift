import AppKit
import EngelbartCore
import EngelbartUI

// The Stage's small views: a flipped box, labels, Plain (what cannot be drawn), the find card (ui/FindCard.jsx), the
// sections menu, the save card, the login prompt, the toast. Values are Stage.jsx's styles, 1 CSS px = 1 pt.

class FlippedView: NSView {
    override var isFlipped: Bool { true }
    var fill: NSColor? { didSet { wantsLayer = true; layer?.backgroundColor = fill?.cgColor } }
}

func makeLabel(_ text: String, size: CGFloat, weight: Int = 400, color: NSColor = Palette.ink, mono: Bool = false, lines: Int = 1) -> NSTextField {
    let l = NSTextField(labelWithString: text)
    l.font = mono ? Fonts.mono(size, weight: weight) : Fonts.sans(size, weight: weight)
    l.textColor = color
    l.maximumNumberOfLines = lines
    l.lineBreakMode = lines == 1 ? .byTruncatingTail : .byWordWrapping
    l.cell?.wraps = lines != 1
    return l
}

/// A borderless text button in a given font and colour, with a hover wash.
final class TextButton: NSButton {
    var onClick: (() -> Void)?
    var wash: NSColor? = Palette.hov
    private var tracking: NSTrackingArea?
    var baseFill: NSColor? { didSet { layer?.backgroundColor = baseFill?.cgColor } }

    init(_ title: String, size: CGFloat = 13, weight: Int = 400, color: NSColor = Palette.mut, radius: CGFloat = 6) {
        super.init(frame: .zero)
        isBordered = false
        wantsLayer = true
        layer?.cornerRadius = radius
        setTitle(title, size: size, weight: weight, color: color)
        target = self; action = #selector(fire)
    }
    required init?(coder: NSCoder) { fatalError() }
    func setTitle(_ title: String, size: CGFloat = 13, weight: Int = 400, color: NSColor = Palette.mut) {
        attributedTitle = NSAttributedString(string: title, attributes: [.font: Fonts.sans(size, weight: weight), .foregroundColor: color])
    }
    @objc private func fire() { onClick?() }
    override func updateTrackingAreas() {
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(t); tracking = t
        super.updateTrackingAreas()
    }
    override func mouseEntered(with event: NSEvent) { if isEnabled, let wash { layer?.backgroundColor = wash.cgColor } }
    override func mouseExited(with event: NSEvent) { layer?.backgroundColor = baseFill?.cgColor }
}

/// What cannot be drawn here (a folder, an unread format, nothing at a path, a failed load): its name and where it is,
/// and what can be done about it.
final class PlainView: FlippedView {
    init(title: String, detail: String = "", error: Bool = false, prose: Bool = false, actions: [(String, Bool, () -> Void)] = []) {
        super.init(frame: .zero)
        fill = Palette.panel2
        let stack = NSStackView()
        stack.orientation = .vertical; stack.alignment = .centerX; stack.spacing = 8
        let t = makeLabel(title, size: 14, weight: 500, lines: 0); t.alignment = .center
        stack.addArrangedSubview(t)
        if !detail.isEmpty {
            let d = makeLabel(detail, size: prose ? 12.5 : 12, color: error ? Palette.del : Palette.fnt, mono: !prose, lines: 0); d.alignment = .center
            if prose { d.preferredMaxLayoutWidth = 320 }
            stack.addArrangedSubview(d)
        }
        if !actions.isEmpty {
            let row = NSStackView(); row.orientation = .horizontal; row.spacing = 8
            for (title, primary, run) in actions {
                let b = TextButton(title, size: 12.5, weight: 500, color: primary ? .white : Palette.ink, radius: 8)
                b.baseFill = primary ? Palette.ink : Palette.panel
                b.layer?.borderWidth = 1; b.layer?.borderColor = (primary ? Palette.ink : Palette.bd).cgColor
                b.onClick = run
                b.translatesAutoresizingMaskIntoConstraints = false
                b.heightAnchor.constraint(equalToConstant: 30).isActive = true
                b.widthAnchor.constraint(greaterThanOrEqualToConstant: b.intrinsicContentSize.width + 24).isActive = true
                row.addArrangedSubview(b)
            }
            stack.setCustomSpacing(18, after: stack.arrangedSubviews.last!)
            stack.addArrangedSubview(row)
        }
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor), stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24), stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -24),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
}

/// ⌘F's card (ui/FindCard.jsx): at the top right, the query, where the match in front is among all of them ("n of m",
/// "0 matches" in red), previous, next, close. Enter and ⇧Enter step; Escape closes.
final class FindCardView: FlippedView, NSTextFieldDelegate {
    let field = NSTextField()
    private let count = makeLabel("", size: 11, color: Palette.fnt, mono: true)
    var onText: ((String) -> Void)?
    var onStep: ((Int) -> Void)?
    var onClose: (() -> Void)?

    init() {
        super.init(frame: .zero)
        fill = Palette.panel
        layer?.cornerRadius = 8; layer?.borderWidth = 1; layer?.borderColor = Palette.bd2.cgColor
        field.isBordered = false; field.drawsBackground = false; field.focusRingType = .none
        field.font = Fonts.sans(13); field.textColor = Palette.ink; field.delegate = self
        field.setAccessibilityLabel("Find on this page")
        addSubview(field); addSubview(count)
        let sep = FlippedView(); sep.fill = Palette.bd; sep.frame = .zero; addSubview(sep); separator = sep
        for (title, step, tip) in [("↑", -1, "⇧⏎"), ("↓", 1, "⏎"), ("×", 0, "esc")] {
            let b = TextButton(title, size: 13, color: step == 0 ? Palette.fnt : Palette.mut)
            b.toolTip = tip
            b.onClick = { [weak self] in if step == 0 { self?.onClose?() } else { self?.onStep?(step) } }
            addSubview(b); buttons.append(b)
        }
    }
    required init?(coder: NSCoder) { fatalError() }
    private var separator: NSView!
    private var buttons: [TextButton] = []

    func show(text: String, found: (matches: Int, active: Int)?) {
        if field.stringValue != text { field.stringValue = text }
        if text.isEmpty || found == nil { count.stringValue = "" }
        else if let f = found, f.matches > 0 { count.stringValue = "\(f.active) of \(f.matches)"; count.textColor = Palette.fnt }
        else { count.stringValue = "0 matches"; count.textColor = Palette.del }
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let h = bounds.height
        var x = bounds.width - 4
        for b in buttons.reversed() { x -= 24; b.frame = NSRect(x: x, y: (h - 24) / 2, width: 24, height: 24) }
        x -= 9; separator.frame = NSRect(x: x, y: (h - 16) / 2, width: 1, height: 16); x -= 4
        count.sizeToFit()
        x -= count.frame.width; count.frame.origin = NSPoint(x: x, y: (h - count.frame.height) / 2)
        field.frame = NSRect(x: 12, y: (h - 20) / 2, width: max(60, x - 16), height: 20)
    }

    func controlTextDidChange(_ obj: Notification) { onText?(field.stringValue) }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.insertNewline(_:)) { onStep?(NSEvent.modifierFlags.contains(.shift) ? -1 : 1); return true }
        if selector == #selector(NSResponder.cancelOperation(_:)) { onClose?(); return true }
        return false
    }
}

/// The sections an @discover guide suggested for the paper in front, where the find card sits: the one shown, a menu of
/// them all to show another, and × to clear the tint and the menu.
final class SectionsMenuView: FlippedView {
    var onPick: ((Int) -> Void)?
    var onClose: (() -> Void)?
    private let button = TextButton("")
    private let close = TextButton("×", size: 13, color: Palette.fnt)
    private var sections: [GuideSection] = []
    private var active = -1

    init() {
        super.init(frame: .zero)
        fill = Palette.panel
        layer?.cornerRadius = 8; layer?.borderWidth = 1; layer?.borderColor = Palette.bd2.cgColor
        button.toolTip = "The sections the guide suggested"
        button.alignment = .left
        button.onClick = { [weak self] in self?.openMenu() }
        close.toolTip = "Clear the section"
        close.onClick = { [weak self] in self?.onClose?() }
        addSubview(button); addSubview(close)
    }
    required init?(coder: NSCoder) { fatalError() }

    func show(_ sections: [GuideSection], active: Int) {
        self.sections = sections; self.active = active
        let title = NSMutableAttributedString(string: "SECTIONS  ", attributes: [.font: Fonts.sans(9, weight: 500), .foregroundColor: Palette.fnt, .kern: 1.6])
        title.append(NSAttributedString(string: active >= 0 && active < sections.count ? sections[active].label : "", attributes: [.font: Fonts.sans(13), .foregroundColor: Palette.ink]))
        title.append(NSAttributedString(string: "  ▾", attributes: [.font: Fonts.sans(10), .foregroundColor: Palette.fnt]))
        button.attributedTitle = title
        needsLayout = true
    }

    override func layout() {
        super.layout()
        close.frame = NSRect(x: bounds.width - 28, y: 5, width: 24, height: 24)
        button.frame = NSRect(x: 4, y: 4, width: bounds.width - 40, height: 26)
    }

    private func openMenu() {
        let menu = NSMenu()
        for (i, s) in sections.enumerated() {
            let item = MenuAction.item(s.label) { [weak self] in self?.onPick?(i) }
            item.state = i == active ? .on : .off
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: bounds.height + 6), in: self)
    }
}

/// "+ Save": the thing's name in the library, then where it goes — the library alone, or the library and this workspace
/// (the heavier button, and what Enter does). Escape or a press elsewhere closes it.
final class SaveCardView: FlippedView, NSTextFieldDelegate {
    let name = NSTextField()
    private let error = makeLabel("", size: 12, color: Palette.del, lines: 0)
    private let library = TextButton("▥  Library only", size: 12.5, weight: 500, color: Palette.mut)
    private let workspace = TextButton("▦  Workspace", size: 12.5, weight: 600, color: Palette.ink)
    var onSave: ((String, Bool) async throws -> Void)?
    var onClose: (() -> Void)?
    private var busy = false
    private let title: String

    init(title: String) {
        self.title = title
        super.init(frame: NSRect(x: 0, y: 0, width: 360, height: 110))
        fill = Palette.panel
        layer?.cornerRadius = 8; layer?.borderWidth = 1; layer?.borderColor = Palette.bd2.cgColor
        shadow = { let s = NSShadow(); s.shadowColor = NSColor(white: 0, alpha: 0.06); s.shadowBlurRadius = 32; s.shadowOffset = NSSize(width: 0, height: -12); return s }()
        name.stringValue = title
        name.isBordered = false; name.drawsBackground = false; name.focusRingType = .none
        name.font = Fonts.sans(14.5, weight: 500); name.textColor = Palette.ink; name.delegate = self
        name.setAccessibilityLabel("Name in the library")
        library.toolTip = "Add to library only"; workspace.toolTip = "Add to library and this workspace"
        workspace.baseFill = Palette.hov; workspace.layer?.borderWidth = 1; workspace.layer?.borderColor = Palette.bd.cgColor
        library.onClick = { [weak self] in self?.commit(false) }
        workspace.onClick = { [weak self] in self?.commit(true) }
        let underline = FlippedView(); underline.fill = Palette.bd
        for v in [name, underline, error, library, workspace] { addSubview(v) }
        name.frame = NSRect(x: 16, y: 23, width: 328, height: 22)
        underline.frame = NSRect(x: 16, y: 47, width: 328, height: 1)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        error.preferredMaxLayoutWidth = 328
        let errorHeight = error.stringValue.isEmpty ? 0 : error.intrinsicContentSize.height + 6
        error.frame = NSRect(x: 16, y: 54, width: 328, height: errorHeight)
        let y = 54 + errorHeight + 10
        let ws = workspace.intrinsicContentSize.width + 16, lib = library.intrinsicContentSize.width + 16
        workspace.frame = NSRect(x: bounds.width - 16 - ws, y: y, width: ws, height: 28)
        library.frame = NSRect(x: workspace.frame.minX - 6 - lib, y: y, width: lib, height: 28)
        let height = y + 28 + 14
        if abs(frame.height - height) > 0.5 { setFrameSize(NSSize(width: frame.width, height: height)) }
    }

    func commit(_ here: Bool) {
        guard !busy else { return }
        busy = true
        error.stringValue = ""
        let chosen = JSStr.trim(name.stringValue).isEmpty ? title : JSStr.trim(name.stringValue)
        Task { @MainActor in
            do { try await onSave?(chosen, here); onClose?() } catch { self.error.stringValue = error.localizedDescription; needsLayout = true }
            busy = false
        }
    }

    func controlTextDidChange(_ obj: Notification) { error.stringValue = ""; needsLayout = true }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.insertNewline(_:)) { commit(true); return true }
        if selector == #selector(NSResponder.cancelOperation(_:)) { onClose?(); return true }
        return false
    }
}

/// HTTP authentication (a staging site, a proxy): the host, its realm, a username and a password; Cancel or Sign in. A
/// sheet on the window (Electron's sat over the whole document: a popup can ask too).
@MainActor
enum LoginPrompt {
    static func ask(_ request: LoginRequest, window: NSWindow?, _ answer: @escaping ((username: String, password: String)?) -> Void) {
        let alert = NSAlert()
        alert.messageText = request.host
        alert.informativeText = request.realm
        let user = NSTextField(frame: NSRect(x: 0, y: 30, width: 280, height: 24)); user.placeholderString = "Username"
        let pass = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24)); pass.placeholderString = "Password"
        let box = NSView(frame: NSRect(x: 0, y: 0, width: 280, height: 56)); box.addSubview(user); box.addSubview(pass)
        alert.accessoryView = box
        alert.addButton(withTitle: "Sign in")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = user
        let finish: (NSApplication.ModalResponse) -> Void = { r in answer(r == .alertFirstButtonReturn ? (user.stringValue, pass.stringValue) : nil) }
        if let window { alert.beginSheetModal(for: window, completionHandler: finish) } else { finish(alert.runModal()) }
    }
}
