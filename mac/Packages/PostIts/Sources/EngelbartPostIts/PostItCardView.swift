import AppKit
import EngelbartCore
import EngelbartUI
import EngelbartDoc
import EngelbartEditor

/// One post-it (renderer/post-its/Card.jsx + face.jsx/face.css + card.css): a flat yellow rectangle with a compact
/// document editor, Copy at the lower left, the quick task's state, Note and Build at the lower right, and the resize
/// handle in the corner. Its frame is where it is in the overlay; while it crumples its bounds stay its full size, so the
/// face is drawn whole and scaled into the shrinking card. It never scrolls: text that does not fit asks the controller
/// to grow the card, and what still does not fit gets smaller type (the editor's bounds scaled against its frame).
public final class PostItCardView: NSView, DocEditorHost {
    weak var controller: PostItsController?
    var entryId = ""
    var entry: PostItsController.Entry? { controller?.entry(entryId) }

    public let editor = DocEditorView(frame: NSRect(x: 0, y: 0, width: 228, height: 216))
    let face = PostItFaceView()
    let placeholder = NSTextField(labelWithString: "Write something…")
    let copyButton = PostItButton(parts: [.icon(PostItLook.copy)], tooltip: "Copy this sticky", label: "Copy")
    let stateButton = PostItButton(parts: [], tooltip: "Open this quick task", label: "")
    let noteButton = PostItButton(parts: [.icon(PostItLook.note), .text("Note")], tooltip: "Copy this into a new note", label: "Note")
    let buildButton = PostItButton(parts: [.text("Build"), .icon(PostItLook.build)], tooltip: "Hand this to a coding agent as a quick task", label: "Build")
    let errorBox = PostItErrorView()
    let resizeHandle = PostItResizeHandle()

    /// The zoom of the type (face.jsx useFit): 1 down to SMALLEST.
    public private(set) var zoom: CGFloat = 1
    public static let SMALLEST: CGFloat = 0.35
    /// Full size while crumpling (Card.jsx crumple { scale, width, height }).
    public private(set) var crumple: (scale: Double, size: CGSize)?
    public private(set) var overTrash = false
    public private(set) var build: BuildBrief?
    public private(set) var saveError: String?
    var cursorPushed = false
    var text = ""
    var press: (start: NSPoint, moved: Bool, kind: GestureKind)?
    var copiedTimer: Timer?, notedTimer: Timer?

    public override var isFlipped: Bool { true }

    public override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = true
        addSubview(face)
        editor.compact = true
        editor.host = self
        face.addSubview(editor)
        placeholder.font = PostItLook.sans(17)
        placeholder.textColor = PostItLook.placeholder
        placeholder.isHidden = true
        face.addSubview(placeholder)
        for button in [copyButton, stateButton, noteButton, buildButton] { face.addSubview(button) }
        copyButton.onPress = { [weak self] in self?.copyCard() }
        noteButton.onPress = { [weak self] in self?.toNote() }
        buildButton.onPress = { [weak self] in guard let self, let entry = self.entry else { return }; self.controller?.askBuild(entry, from: self.buildButton) }
        stateButton.onPress = { [weak self] in guard let self, let entry = self.entry else { return }; self.controller?.openBuild(entry, from: self.stateButton) }
        stateButton.isHidden = true
        errorBox.isHidden = true
        face.addSubview(errorBox)
        resizeHandle.card = self
        face.addSubview(resizeHandle)
        // Self-test markers, named after Card.jsx's data-* attributes.
        DriveTag.mark(copyButton, "copy-post-it")
        DriveTag.mark(noteButton, "note-post-it")
        DriveTag.mark(buildButton, "build-post-it")
        DriveTag.mark(stateButton, "post-it-build-state")
        DriveTag.mark(resizeHandle, "resize-post-it")
        DriveTag.mark(errorBox, "post-error")
        adaptEditor()
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Sticky")
    }
    required init?(coder: NSCoder) { fatalError() }

    /// The editor drawn on the yellow: no white page, no scroller (a card never scrolls), labelled "Sticky".
    func adaptEditor() {
        guard let text = textView else { return }
        text.drawsBackground = false
        text.setAccessibilityLabel("Sticky")
        if let scroll = text.enclosingScrollView {
            scroll.drawsBackground = false
            scroll.hasVerticalScroller = false
            scroll.hasHorizontalScroller = false
            scroll.verticalScrollElasticity = .none
        }
    }

    var textView: NSTextView? { Self.find(NSTextView.self, in: editor) }
    static func find<T: NSView>(_ type: T.Type, in view: NSView) -> T? {
        for sub in view.subviews {
            if let hit = sub as? T { return hit }
            if let deeper = find(type, in: sub) { return deeper }
        }
        return nil
    }

    // MARK: place and draw

    /// Where it is in the overlay (points). While crumpling the bounds stay full size.
    func place(_ rect: PRect) {
        let frame = rect.cgRect
        if self.frame != frame { setFrameOrigin(frame.origin); setFrameSize(frame.size) }
        applyBounds()
    }

    func applyBounds() {
        let size = crumple?.size ?? frame.size
        if bounds.size != size || bounds.origin != .zero { bounds = CGRect(origin: .zero, size: size) }
        layoutParts()
    }

    func setCrumple(_ value: (scale: Double, size: CGSize)?) {
        crumple = value
        applyBounds()
    }

    func setOverTrash(_ value: Bool) {
        guard value != overTrash else { return }
        overTrash = value
        face.fade(to: value ? PostItLook.faceOverTrash : PostItLook.face)
    }

    func gestureCancelled() {
        press = nil
        setOverTrash(false)
        setCrumple(nil)
        if cursorPushed { NSCursor.pop(); cursorPushed = false }
    }

    var faceSize: CGSize { bounds.size }
    static let head: CGFloat = 14, foot: CGFloat = 30
    /// The room the text has (.postit-body): the card less its head and foot, less 16 a side.
    var room: CGFloat { max(0, faceSize.height - Self.head - Self.foot) }

    var laidSize: CGSize = .zero
    func layoutParts() {
        let w = faceSize.width, h = faceSize.height
        face.frame = CGRect(x: 0, y: 0, width: w, height: h)
        let bodyWidth = max(1, w - 32)
        let resized = laidSize != CGSize(width: w, height: h)
        laidSize = CGSize(width: w, height: h)
        editor.frame = CGRect(x: 16, y: Self.head, width: bodyWidth, height: max(1, room))
        applyZoom(zoom)
        placeholder.sizeToFit()
        placeholder.frame.origin = CGPoint(x: 16, y: Self.head + 4)
        // The foot: Copy on the left (padding 10), the words on the right (padding 26), each 22 high, centred.
        let footY = h - Self.foot
        copyButton.frame = CGRect(x: 10, y: footY + 4, width: 22, height: 22)
        var right = w - 26
        for button in [buildButton, noteButton, stateButton] where !button.isHidden {
            let width = button.intrinsicContentSize.width
            right -= width
            button.frame = CGRect(x: right, y: footY + 4, width: width, height: 22)
            right -= 14
        }
        resizeHandle.frame = CGRect(x: w - 24, y: h - 24, width: 22, height: 22)
        if !errorBox.isHidden {
            let height = errorBox.height(width: max(1, w - 24))
            errorBox.frame = CGRect(x: 12, y: h - 30 - height, width: max(1, w - 24), height: height)
        }
        if resized { refit() }
    }

    public override func layout() {
        super.layout()
        layoutParts()
    }

    public override func resetCursorRects() {
        addCursorRect(bounds, cursor: press?.moved == true ? .closedHand : .openHand)
    }

    // MARK: text

    func load(text: String) {
        self.text = text
        DriveTag.mark(self, "post-it=\(entryId)")
        editor.setDocument(key: entryId, text: text)
        adaptEditor()
        placeholder.isHidden = !text.isEmpty
        buildButton.isEnabled = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        layoutParts()
        refit()
    }

    /// The same card saved in another window: its text is the latest.
    func receive(text: String) {
        guard text != self.text else { return }
        self.text = text
        editor.setText(text)
        placeholder.isHidden = !text.isEmpty
        buildButton.isEnabled = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        textChanged()
    }

    public func docEditor(_ editor: DocEditorView, changed text: String) {
        self.text = text
        placeholder.isHidden = !text.isEmpty
        buildButton.isEnabled = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if let entry { controller?.edit(entry, text) }
        DispatchQueue.main.async { [weak self] in self?.textChanged() }
    }
    public func docEditor(_ editor: DocEditorView, openLink href: String, newTab: Bool, sections: [String]?) { controller?.openLink(href) }
    public func docEditor(_ editor: DocEditorView, copy text: String) { do { try controller?.copy(text) } catch { setError(errorText(error)) } }
    public func docEditor(_ editor: DocEditorView, error: Error) { controller?.report(error) }

    // MARK: fit (face.jsx)

    /// The editor drawn at `z`: its bounds are its frame ÷ z, so its lines wrap at the wider width and draw smaller.
    func applyZoom(_ z: CGFloat) {
        let size = CGSize(width: editor.frame.width / z, height: editor.frame.height / z)
        if editor.bounds.size != size { editor.setBoundsSize(size) }
        editor.needsLayout = true
        editor.layoutSubtreeIfNeeded()
    }

    /// The text's height drawn at `z` (points of the card).
    func contentAt(_ z: CGFloat) -> CGFloat { applyZoom(z); return editor.contentHeight * z }

    /// The largest zoom in [SMALLEST, 1] at which the text fits the room (bisection, measured live).
    func largestFit() -> CGFloat {
        let room = self.room
        let tall = { (z: CGFloat) in self.contentAt(z) > room + 0.5 }
        if !tall(1) { return 1 }
        if tall(Self.SMALLEST) { return Self.SMALLEST }
        var lo = Self.SMALLEST, hi: CGFloat = 1
        for _ in 0..<9 { let mid = (lo + hi) / 2; if tall(mid) { hi = mid } else { lo = mid } }
        return (lo * 1000).rounded(.down) / 1000
    }

    var fitting = false
    /// Fits the type to the card again, up to 1 (the card resized, by hand or after growing).
    func refit() {
        guard !fitting, room > 0, window != nil || superview != nil else { return }
        fitting = true
        defer { fitting = false }
        let next = largestFit()
        applyZoom(next)
        zoom = next
        if let scroll = textView?.enclosingScrollView { scroll.contentView.scroll(to: .zero); scroll.reflectScrolledClipView(scroll.contentView) }
    }

    /// Typing: text that overflows at the zoom it has asks for more room first (a floating card gets taller as far as the
    /// window lets it); the zoom then follows whatever size the card has.
    func textChanged() {
        guard room > 0 else { return }
        applyZoom(zoom)
        let over = editor.contentHeight * zoom - room
        if over > 0.5, let entry, let controller {
            controller.grow(entry, Double(faceSize.height + over))
            layoutParts()
        }
        refit()
    }

    // MARK: footer

    func setBuild(_ brief: BuildBrief?) {
        build = brief
        let word = brief?.word ?? ""
        let idle = BuildBrief.idle(brief)
        buildButton.isHidden = !idle
        buildButton.isEnabled = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        stateButton.isHidden = word.isEmpty
        if let brief, !word.isEmpty {
            var parts: [PostItButton.Part] = []
            if brief.moved { parts.append(.icon(PostItLook.workspace)) }
            parts.append(.word(word))
            if brief.isWorking { parts.append(.dots) }
            stateButton.parts = parts
            stateButton.strong = brief.strong
            stateButton.isEnabled = !brief.disabled
            stateButton.toolTip = brief.moved ? "Open \(brief.workspace ?? "")" : "Open this quick task"
            DriveTag.mark(stateButton, "post-it-build-state=\(brief.status)")
        }
        layoutParts()
    }

    /// Copy (lower left, 2026-09-22): the card's markdown as written, to paste wherever it belongs; a check for 1.4 s.
    func copyCard() {
        do {
            try controller?.copy(text)
            copyButton.parts = [.icon(PostItLook.check)]
            copiedTimer?.invalidate()
            copiedTimer = Timer.scheduledTimer(withTimeInterval: 1.4, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.copyButton.parts = [.icon(PostItLook.copy)] }
            }
        } catch { setError(errorText(error)) }
    }

    /// +Note: "Opened" for 1.6 s once the note is made.
    func toNote() {
        guard let entry, let controller else { return }
        Task { @MainActor [weak self] in
            do {
                _ = try await controller.toNote(entry)
                guard let self else { return }
                self.noteButton.parts = [.icon(PostItLook.note), .text("Opened")]
                self.layoutParts()
                self.notedTimer?.invalidate()
                self.notedTimer = Timer.scheduledTimer(withTimeInterval: 1.6, repeats: false) { [weak self] _ in
                    MainActor.assumeIsolated { self?.noteButton.parts = [.icon(PostItLook.note), .text("Note")]; self?.layoutParts() }
                }
            } catch { self?.setError(errorText(error)) }
        }
    }

    func setError(_ message: String?) {
        saveError = message
        errorBox.text = message.map { "Couldn’t save: \($0)" } ?? ""
        errorBox.isHidden = message == nil
        layoutParts()
    }

    // MARK: pressing and dragging

    /// A press goes to the editor only on a glyph (Card.jsx hitsText: the whitespace beside and below a line drags), to a
    /// button, or to anything the editor draws over its text; everywhere else it is the card's.
    public override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, frame.contains(point) else { return nil }
        if press != nil { return self }
        guard let hit = super.hitTest(point) else { return nil }
        if hit is PostItButton || hit is PostItResizeHandle || hit.isDescendant(of: errorBox) { return hit }
        if let tv = textView, hit === tv {
            let local = tv.convert(point, from: superview)
            return hitsText(tv, local) ? hit : self
        }
        if hit.isDescendant(of: editor), hit !== editor, !(hit is NSScrollView), !(hit is NSClipView) { return hit }
        return self
    }

    func hitsText(_ tv: NSTextView, _ p: NSPoint) -> Bool {
        guard let lm = tv.layoutManager, let container = tv.textContainer, lm.numberOfGlyphs > 0 else { return false }
        let origin = tv.textContainerOrigin
        let q = NSPoint(x: p.x - origin.x, y: p.y - origin.y)
        let glyph = lm.glyphIndex(for: q, in: container)
        for g in [glyph - 1, glyph] where g >= 0 && g < lm.numberOfGlyphs {
            let r = lm.boundingRect(forGlyphRange: NSRange(location: g, length: 1), in: container)
            if r.width > 0, q.x >= r.minX, q.x <= r.maxX, q.y >= r.minY, q.y <= r.maxY {
                let c = lm.characterIndexForGlyph(at: g)
                if let s = tv.textStorage?.string as NSString?, c < s.length, s.character(at: c) == 10 { continue } // a line's end
                return true
            }
        }
        return false
    }

    func overlayPoint(_ event: NSEvent) -> CGPoint {
        guard let overlay = superview else { return event.locationInWindow }
        return overlay.convert(event.locationInWindow, from: nil)
    }

    public override func mouseDown(with event: NSEvent) { begin(event, .drag) }
    public override func mouseDragged(with event: NSEvent) { moved(event) }
    public override func mouseUp(with event: NSEvent) { end(event) }

    func begin(_ event: NSEvent, _ kind: GestureKind) {
        guard event.type == .leftMouseDown, let entry else { return }
        press = (event.locationInWindow, false, kind)
        if !cursorPushed { NSCursor.closedHand.push(); cursorPushed = true }
        controller?.gesture(entry, .begin, kind, overlayPoint(event))
    }

    func moved(_ event: NSEvent) {
        guard var p = press, let entry else { return }
        if hypot(event.locationInWindow.x - p.start.x, event.locationInWindow.y - p.start.y) >= 4 { p.moved = true }
        press = p
        if p.moved { controller?.gesture(entry, .move, p.kind, overlayPoint(event)) }
    }

    func end(_ event: NSEvent) {
        guard let p = press, let entry else { return }
        press = nil
        if cursorPushed { NSCursor.pop(); cursorPushed = false }
        controller?.gesture(entry, .end, p.kind, overlayPoint(event))
        window?.invalidateCursorRects(for: self)
        // A press that did not move puts the caret at the end of the text (a drag that moved swallows the click).
        if !p.moved && p.kind == .drag { editor.focusEnd() }
    }

    func keyResize(dx: Double, dy: Double) {
        guard let entry else { return }
        controller?.resizeBy(entry, dx: dx, dy: dy)
    }

    public override func accessibilityIdentifier() -> String { "post-it=\(entryId)" }
}

/// The save error on a card: a white box, red 12/1.4 text, at most 80 high, scrolling inside.
final class PostItErrorView: NSView {
    let label = NSTextField(wrappingLabelWithString: "")
    var text: String { get { label.stringValue } set { label.stringValue = newValue } }
    override var isFlipped: Bool { true }
    override init(frame: NSRect) {
        super.init(frame: frame)
        label.font = PostItLook.sans(12)
        label.textColor = PostItLook.saveError
        label.setAccessibilityRole(.staticText)
        addSubview(label)
        setAccessibilityRole(.staticText)
        setAccessibilityIdentifier("post-error")
    }
    required init?(coder: NSCoder) { fatalError() }
    func height(width: CGFloat) -> CGFloat {
        let size = label.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: width - 12, height: 10_000)) ?? .zero
        return min(80, ceil(size.height) + 12)
    }
    override func layout() { super.layout(); label.frame = bounds.insetBy(dx: 6, dy: 6) }
    override func draw(_ dirtyRect: NSRect) { NSColor.white.setFill(); dirtyRect.fill() }
    override func accessibilityValue() -> Any? { text }
}

/// The resize handle (22×22 at the corner): its glyph only on hover or keyboard focus; arrows resize by 20.
final class PostItResizeHandle: NSView {
    weak var card: PostItCardView?
    var hovering = false { didSet { needsDisplay = true } }
    var focused = false { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }
    override init(frame: NSRect) {
        super.init(frame: frame)
        toolTip = "Drag to resize"
        setAccessibilityLabel("Resize sticky")
        setAccessibilityRole(.button)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func resetCursorRects() {
        if #available(macOS 15.0, *) { addCursorRect(bounds, cursor: NSCursor.frameResize(position: .bottomRight, directions: .all)) }
        else { addCursorRect(bounds, cursor: .crosshair) }
    }
    override func mouseDown(with event: NSEvent) { card?.begin(event, .resize) }
    override func mouseDragged(with event: NSEvent) { card?.moved(event) }
    override func mouseUp(with event: NSEvent) { card?.end(event) }
    // Focus by keyboard only (Tab), as a button that a click does not focus.
    override var acceptsFirstResponder: Bool { NSApp.currentEvent?.type == .keyDown }
    override var canBecomeKeyView: Bool { true }
    override func becomeFirstResponder() -> Bool { focused = true; return true }
    override func resignFirstResponder() -> Bool { focused = false; return true }
    override func keyDown(with event: NSEvent) {
        let dx: Double = event.keyCode == 124 ? 20 : event.keyCode == 123 ? -20 : 0
        let dy: Double = event.keyCode == 125 ? 20 : event.keyCode == 126 ? -20 : 0
        if dx == 0 && dy == 0 { super.keyDown(with: event); return }
        card?.keyResize(dx: dx, dy: dy)
    }
    override func draw(_ dirtyRect: NSRect) {
        if focused {
            PostItLook.focus.setStroke()
            let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: 4, dy: 4)); ring.lineWidth = 2; ring.stroke()
        }
        guard hovering || focused, let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.saveGState()
        ctx.translateBy(x: (bounds.width - 12) / 2, y: (bounds.height - 12) / 2)
        PostItLook.resize.draw(in: ctx, side: 12, color: PostItLook.word.withAlphaComponent(0.7).cgColor)
        ctx.restoreGState()
    }
    override func accessibilityIdentifier() -> String { "resize-post-it" }
}

/// The face (face.css .postit-face): flat yellow, no shadow, tilt or folded corner; its colour changes over 120 ms.
final class PostItFaceView: NSView {
    private(set) var color = PostItLook.face
    private var from = PostItLook.face, to = PostItLook.face
    private var started = Date.distantPast
    private var timer: Timer?
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        color.setFill()
        dirtyRect.fill()
    }
    func fade(to target: NSColor, duration: TimeInterval = 0.12) {
        from = color; to = target; started = Date()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] t in
            MainActor.assumeIsolated {
                guard let self else { t.invalidate(); return }
                let k = min(1, Date().timeIntervalSince(self.started) / duration)
                self.color = self.from.blended(withFraction: k, of: self.to) ?? self.to
                self.needsDisplay = true
                if k >= 1 { t.invalidate(); self.color = self.to }
            }
        }
    }
}
