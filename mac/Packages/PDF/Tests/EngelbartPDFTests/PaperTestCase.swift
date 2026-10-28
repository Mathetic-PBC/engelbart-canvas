import AppKit
import XCTest
@testable import EngelbartPDF

/// The paper in an offscreen window (made with defer: false, never ordered front) over a pdf made in the test, with
/// synthesized events and pixel reads.
@MainActor
class PaperTestCase: XCTestCase {
    let lines = ["The quick brown fox jumps over the lazy dog on page #", "Cohen's kappa was 0.79 overall across the deployments", "A third line about construc-", "tion of the thing we study", "lorem ipsum dolor sit amet", "lorem again"]
    var window: NSWindow!
    var paper: PaperViewController!
    var host: FakePaperHost!

    func open(pages: Int = 2, marks: PaperMarks? = nil, width: CGFloat = 612, height: CGFloat = 700, title: String? = nil,
              view: PaperViewState? = nil, initialSection: (find: String, to: String)? = nil, before: ((FakePaperHost) -> Void)? = nil) {
        _ = NSApplication.shared
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        paper = PaperViewController()
        host = FakePaperHost()
        before?(host)
        paper.host = host
        paper.paperTitle = title
        window.contentView = paper.view
        paper.scrollView.scrollerStyle = .overlay
        paper.view.frame = NSRect(x: 0, y: 0, width: width, height: height)
        paper.view.layoutSubtreeIfNeeded()
        paper.load(data: makePDF(pages: pages, lines: lines), marks: marks, view: view, initialSection: initialSection)
        spin { self.paper.laidOut }
        // the marks of the pages in view drawn (the drawing loop does it a turn after the layout)
        spin { self.paper.sheets.prefix(2).allSatisfy { $0.marksW != nil } }
    }

    override func tearDown() { paper?.close(); window?.close(); window = nil; paper = nil; host = nil; super.tearDown() }

    func spin(_ seconds: Double = 3, until done: @escaping () -> Bool) {
        let end = Date().addingTimeInterval(seconds)
        while !done() && Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    }
    func spin(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
    func textRead(_ n: Int = 1) { spin { self.paper.texts[n] != nil } }

    func windowPoint(_ canvasPoint: NSPoint) -> NSPoint { paper.canvas.convert(canvasPoint, to: nil) }
    func mouse(_ type: NSEvent.EventType, window p: NSPoint, clicks: Int = 1) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!
    }
    func mouse(_ type: NSEvent.EventType, _ p: NSPoint) -> NSEvent { mouse(type, window: windowPoint(p)) }
    func key(_ chars: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags = []) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
    }
    func click(_ p: NSPoint) { paper.canvas.mouseDown(with: mouse(.leftMouseDown, p)); paper.canvas.mouseUp(with: mouse(.leftMouseUp, p)) }
    func drag(_ a: NSPoint, _ b: NSPoint, release: Bool = true) {
        paper.canvas.mouseDown(with: mouse(.leftMouseDown, a))
        paper.canvas.mouseDragged(with: mouse(.leftMouseDragged, NSPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)))
        paper.canvas.mouseDragged(with: mouse(.leftMouseDragged, b))
        if release { paper.canvas.mouseUp(with: mouse(.leftMouseUp, b)) }
    }
    /// Page n's text line i at `pts` points across, in the canvas.
    func linePoint(page n: Int, line i: Int, x pts: Double) -> NSPoint {
        let k = paper.pageW / 612
        return NSPoint(x: paper.G + pts * k, y: paper.tops[n - 1] + (100 + Double(i) * 20 - 4) * k)
    }
    /// A highlight over line i of page 1 (72 → 72 + w points).
    func highlight(_ id: String, line i: Int = 0, w: Double = 200, note: String? = nil, asks: [AskEntry]? = nil, side: String = "left") -> Mark {
        let top = (100 + Double(i) * 20 - 14) / 612
        var m = Mark(id: id, rects: [PRect(72 / 612, top, w / 612, 16 / 612)], side: side, y: top, note: note, text: "The quick brown")
        m.asks = asks
        return m
    }
    func selectLine(_ i: Int = 0, page: Int = 1) {
        drag(linePoint(page: page, line: i, x: 80), linePoint(page: page, line: i, x: 200))
    }

    /* -------------------------------------------------------------------------------------------- pixels */

    struct Pixels {
        let w: Int, h: Int, data: [UInt8]
        func rgb(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int, a: Int) {
            let i = (y * w + x) * 4
            return (Int(data[i]), Int(data[i + 1]), Int(data[i + 2]), Int(data[i + 3]))
        }
        /// How many pixels in columns x0..<x1 (every row) satisfy `test`.
        func count(x0: Int = 0, x1: Int? = nil, _ test: ((r: Int, g: Int, b: Int, a: Int)) -> Bool) -> Int {
            var n = 0
            for y in 0..<h { for x in max(0, x0)..<min(w, x1 ?? w) where test(rgb(x, y)) { n += 1 } }
            return n
        }
        func near(_ c: (r: Int, g: Int, b: Int, a: Int), _ hex: String, _ tol: Int = 6) -> Bool {
            let v = Int(hex.dropFirst(), radix: 16)!
            return abs(c.r - (v >> 16 & 255)) <= tol && abs(c.g - (v >> 8 & 255)) <= tol && abs(c.b - (v & 255)) <= tol
        }
        func has(_ hex: String, _ tol: Int = 6) -> Bool { count { near($0, hex, tol) } > 0 }
    }

    /// A layer tree drawn at 1× on white (CALayer.render), its own drawing brought up to date first.
    func pixels(_ layer: CALayer, size: CGSize? = nil) -> Pixels {
        func displayAll(_ l: CALayer) { l.displayIfNeeded(); l.sublayers?.forEach(displayAll) }
        displayAll(layer)
        let s = size ?? layer.bounds.size
        let w = max(1, Int(s.width.rounded())), h = max(1, Int(s.height.rounded()))
        var data = [UInt8](repeating: 255, count: w * h * 4)
        data.withUnsafeMutableBytes { buf in
            let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            layer.render(in: ctx)
        }
        return Pixels(w: w, h: h, data: data)
    }

    /// A view drawn (its draw(_:) into its layer, then the layer tree rendered).
    func pixels(_ v: NSView) -> Pixels {
        v.layoutSubtreeIfNeeded()
        v.display()
        return pixels(v.layer!, size: v.bounds.size)
    }
}
