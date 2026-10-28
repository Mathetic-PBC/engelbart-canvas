import AppKit
import EngelbartDoc
import EngelbartUI

// The picture viewer (ImageViewer.jsx, 2026-10-15/16): over the whole window, the backdrop rgba(10,10,10,.66). The picture
// fits the window less 56px a side, never past 1 image pixel per point; a click on it toggles fit and 100%, where a drag
// moves it. One control, Close (a bare ×), 10px in from the top-right corner of what shows of the picture. ⌘C or the
// right-click menu (Copy image) copies it, the hint saying "Copied" for 1.4 s; ← → step through the note's pictures;
// Escape or the backdrop closes it, and the keyboard goes back to the editor.

enum ImageViewer {
    struct Pic { var image: NSImage; var alt: String }
    static let MARGIN: CGFloat = 56
    static let HINT = "Click to zoom · ⌘C to copy · Esc to close"

    @discardableResult
    static func show(_ pics: [Pic], at: Int, over window: NSWindow?, onClose: @escaping () -> Void = {}) -> ViewerView? {
        guard let window, let content = window.contentView, !pics.isEmpty else { return nil }
        let v = ViewerView(pics: pics, at: max(0, min(at, pics.count - 1)))
        v.onClose = onClose
        v.frame = content.bounds; v.autoresizingMask = [.width, .height]
        content.addSubview(v)
        window.makeFirstResponder(v)
        return v
    }
    static func show(_ image: NSImage, over window: NSWindow?) { show([Pic(image: image, alt: "")], at: 0, over: window) }

    final class ViewerView: NSView {
        let pics: [Pic]
        private(set) var at: Int
        private(set) var zoomed = false
        /// At 100%: the picture's offset from centred, moved by a drag.
        private(set) var pan = CGPoint.zero
        private(set) var copied = false
        var onClose: () -> Void = {}
        var copy: (NSImage) -> Bool = { image in NSPasteboard.general.clearContents(); return NSPasteboard.general.writeObjects([image]) }
        let close = IconButton(["M18 6 6 18", "m6 6 12 12"], tip: "Close", size: 15, box: 30)
        init(pics: [Pic], at: Int) {
            self.pics = pics; self.at = at
            super.init(frame: .zero)
            close.color = NSColor(hex: "#262626")
            close.onClick = { [weak self] in self?.shut() }
            addSubview(close)
            setAccessibilityRole(.group); setAccessibilityLabel(pics[at].alt.isEmpty ? "Image" : pics[at].alt)
        }
        required init?(coder: NSCoder) { fatalError() }
        override var acceptsFirstResponder: Bool { true }
        override var isFlipped: Bool { true }
        var pic: Pic { pics[at] }
        var fit: CGFloat {
            let s = pic.image.size
            return min((bounds.width - 2 * ImageViewer.MARGIN) / max(1, s.width), (bounds.height - 2 * ImageViewer.MARGIN) / max(1, s.height), 1)
        }
        var canZoom: Bool { fit < 1 }
        /// Where the picture is drawn.
        var pictureRect: NSRect {
            let k = zoomed ? 1 : fit, s = pic.image.size
            let w = s.width * k, h = s.height * k
            return NSRect(x: (bounds.width - w) / 2 + (zoomed ? pan.x : 0), y: (bounds.height - h) / 2 + (zoomed ? pan.y : 0), width: w, height: h)
        }
        func step(_ by: Int) {
            let i = at + by
            guard pics.count > 1, i >= 0, i < pics.count else { return }
            at = i; zoomed = false; pan = .zero
            setAccessibilityLabel(pic.alt.isEmpty ? "Image" : pic.alt)
            needsLayout = true; needsDisplay = true
        }
        func toggleZoom() { guard canZoom else { return }; zoomed.toggle(); pan = .zero; needsLayout = true; needsDisplay = true }
        func copyNow() {
            guard copy(pic.image) else { return }
            copied = true; needsDisplay = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in self?.copied = false; self?.needsDisplay = true }
        }
        func shut() { removeFromSuperview(); onClose() }
        override func layout() {
            super.layout()
            let r = pictureRect
            let right = min(r.maxX, bounds.width), top = max(r.minY, 0)
            close.frame = NSRect(x: right - 10 - 30, y: top + 10, width: 30, height: 30)
        }
        override func draw(_ dirtyRect: NSRect) {
            NSColor(srgbRed: 10 / 255, green: 10 / 255, blue: 10 / 255, alpha: 0.66).setFill(); bounds.fill()
            let r = pictureRect
            NSGraphicsContext.saveGraphicsState()
            let shadow = NSShadow(); shadow.shadowBlurRadius = 35; shadow.shadowOffset = NSSize(width: 0, height: -24); shadow.shadowColor = NSColor(white: 0, alpha: 0.45); shadow.set()
            let clip = NSBezierPath(roundedRect: r, xRadius: 8, yRadius: 8)
            NSColor.white.setFill(); clip.fill()
            NSGraphicsContext.restoreGraphicsState()
            NSGraphicsContext.saveGraphicsState(); clip.addClip()
            pic.image.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            NSGraphicsContext.restoreGraphicsState()
            let hint = copied ? "Copied" : ImageViewer.HINT
            let a: [NSAttributedString.Key: Any] = [.font: Fonts.sans(12.5), .foregroundColor: copied ? Look.ink : NSColor(white: 1, alpha: 0.55)]
            let sz = (hint as NSString).size(withAttributes: a)
            let at = NSPoint(x: (bounds.width - sz.width) / 2, y: bounds.height - 16 - sz.height)
            if copied {
                NSColor(white: 1, alpha: 0.95).setFill()
                NSBezierPath(roundedRect: NSRect(x: at.x - 12, y: at.y - 5, width: sz.width + 24, height: sz.height + 10), xRadius: 999, yRadius: 999).fill()
            }
            (hint as NSString).draw(at: at, withAttributes: a)
        }
        override func mouseDown(with event: NSEvent) {
            let p0 = convert(event.locationInWindow, from: nil)
            guard pictureRect.contains(p0) else {
                // The backdrop: closes once let go there.
                if let w = window, let up = w.nextEvent(matching: [.leftMouseUp]), !pictureRect.contains(convert(up.locationInWindow, from: nil)) { shut() }
                return
            }
            var moved = false
            let start = pan
            while let e = window?.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
                let p = convert(e.locationInWindow, from: nil)
                if e.type == .leftMouseUp { break }
                if !moved && hypot(p.x - p0.x, p.y - p0.y) < 4 { continue }
                moved = true
                if zoomed { pan = CGPoint(x: start.x + p.x - p0.x, y: start.y + p.y - p0.y); needsLayout = true; needsDisplay = true }
            }
            if !moved { toggleZoom() }
        }
        override func rightMouseDown(with event: NSEvent) {
            let m = NSMenu()
            let item = NSMenuItem(title: "Copy image", action: #selector(copyItem), keyEquivalent: "")
            item.target = self; m.addItem(item)
            NSMenu.popUpContextMenu(m, with: event, for: self)
        }
        @objc func copyItem() { copyNow() }
        override func keyDown(with event: NSEvent) {
            switch event.keyCode {
            case 53: shut(); return
            case 123: step(-1); return
            case 124: step(1); return
            default: break
            }
            if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "c" { copyNow(); return }
            super.keyDown(with: event)
        }
        override func cancelOperation(_ sender: Any?) { shut() }
    }
}

extension DocEditorView {
    /// The note's pictures in order (its picture lines and pictures inside lines), each by its id.
    func notePictures() -> [(id: String, pic: ImageViewer.Pic)] {
        guard let host else { return [] }
        var out: [(String, ImageViewer.Pic)] = []
        let token = Rx(#"!\[([^\]\n]*)\]\(img:([\w-]+)\)"#)
        for line in core.lines {
            for m in token.matchAll(line) {
                let id = m[2]!
                if let image = host.docEditor(self, image: id) { out.append((id, ImageViewer.Pic(image: image, alt: EditorText.imgParts(m[1] ?? "").name))) }
            }
        }
        return out.map { (id: $0.0, pic: $0.1) }
    }
    /// A picture clicked: the viewer on it, ← → through the note's others; closed, the keyboard comes back to the editor.
    @discardableResult
    func openPicture(_ id: String) -> ImageViewer.ViewerView? {
        let all = notePictures()
        guard let at = all.firstIndex(where: { $0.id == id }) else { return nil }
        return ImageViewer.show(all.map { $0.pic }, at: at, over: window) { [weak self] in
            guard let self else { return }
            self.window?.makeFirstResponder(self.textView)
        }
    }
}
