import Foundation
import CoreGraphics
import EngelbartCore

// Boxes on web pages (MATH-70, src/main/browser/boxes.cjs): a rectangle drawn over part of a page, kept as a mark in the
// page's ink beside its highlights:
//   { id, box: { x, y, w, h, anchor: { selector, tag, src, text }, doc: { x, y, w, h, width } }, crop, text, note, at }
// Drawn without touching the page's DOM: one author rule, `html::after`, out of flow and inert, its background an SVG of
// every box (boxesCss). 2026-10-17 (David: "much smaller and lighter, like ⌘⇧4"): every box a 1px white line with a 1px
// half-black halo outside it; a box being drawn or resized has a 6% grey tint; handles are 5px white squares.

public enum Boxes {
    public static let textMax = 2000
    public static let selectorMax = 1000
    public static let anchorText = 80
    public static let srcMax = 2048
    public static let maxBoxes = 200
    public static let maxNotes = 500
    public static let noteChipColor = "#0070f3"
    public static let line = "#fff"
    public static let halo = "rgba(0,0,0,0.5)"
    public static let tint = "rgba(128,128,128,0.06)"
    public static let handle: Double = 5
    public static var pad: Double { (handle / 2).rounded(.up) + 2 }
    public static let handles: [(String, Double, Double)] = [("nw", 0, 0), ("n", 0.5, 0), ("ne", 1, 0), ("e", 1, 0.5), ("se", 1, 1), ("s", 0.5, 1), ("sw", 0, 1), ("w", 0, 0.5)]
    public static let cardGap: Double = 8
    public static let readoutCSS = "font:500 11px/1.2 -apple-system,BlinkMacSystemFont,\"SF Pro Text\",\"Helvetica Neue\",sans-serif;font-variant-numeric:tabular-nums;"
        + "letter-spacing:0;color:#fff;background:rgba(0,0,0,0.72);padding:2px 5px;border-radius:4px;white-space:pre;text-align:left"
    public static let readoutGap: Double = 10
    public static let readoutDigit: Double = 7
    public static let readoutPad: Double = 10
    public static let readoutHeight: Double = 31

    static func finite(_ v: JSONValue?, _ limit: Double = 1e6) -> Double? {
        guard let n = v?.double, n.isFinite, abs(n) <= limit else { return nil }
        return n
    }
    static func str(_ v: JSONValue?, _ max: Int) -> String { JSStr.slice(v?.string ?? "", 0, max) }

    /// An anchor as the page sends it: { selector, tag, src, text } of bounded strings; nil without a selector or tag.
    public static func anchorInput(_ value: JSONValue?) -> JSONValue? {
        guard value?.object != nil else { return nil }
        let selector = str(value?["selector"], selectorMax), tag = str(value?["tag"], 32).lowercased()
        guard !selector.isEmpty, SRx(#"^[a-z][a-z0-9-]*$"#).test(tag) else { return nil }
        return ["selector": .string(selector), "tag": .string(tag), "src": .string(str(value?["src"], srcMax)), "text": .string(str(value?["text"], anchorText))]
    }

    /// A box as the page sends it or the ink keeps it, with finite numbers, a size and its document rectangle; nil otherwise.
    public static func boxInput(_ value: JSONValue?) -> JSONValue? {
        guard let v = value, v.object != nil else { return nil }
        guard let x = finite(v["x"], 1e4), let y = finite(v["y"], 1e4), let w = finite(v["w"], 1e4), let h = finite(v["h"], 1e4), w > 0, h > 0 else { return nil }
        let doc = v["doc"]
        guard let dx = finite(doc?["x"]), let dy = finite(doc?["y"]), let dw = finite(doc?["w"]), let dh = finite(doc?["h"]), let width = finite(doc?["width"]), dw > 0, dh > 0 else { return nil }
        return ["x": .number(x), "y": .number(y), "w": .number(w), "h": .number(h), "anchor": anchorInput(v["anchor"]) ?? .null,
                "doc": ["x": .number(dx), "y": .number(dy), "w": .number(dw), "h": .number(dh), "width": .number(width)]]
    }

    /// A mark that is a box (`box` an object): every reader of the "web" list asks this before reading a quote.
    public static func isBox(_ m: JSONValue?) -> Bool { m?["box"]?.object != nil }

    /// Where a box's picture is kept, relative to the annotations folder.
    public static func cropName(_ id: String) -> String { "crops/\(id).png" }
    static let cropRx = SRx(#"^crops\/([\w-]{1,64})\.png$"#)

    /// Which picture of mark `id` a crop name is: 0 for "crops/<id>.png", n for "crops/<id>-<n>.png", -1 for none of its.
    public static func cropNumber(_ id: String?, _ crop: String?) -> Int {
        guard let id, let crop, let m = cropRx.match(crop), let name = m[1] else { return -1 }
        if name == id { return 0 }
        let n = name.hasPrefix("\(id)-") ? JSStr.slice(name, JSStr.len(id) + 1) : ""
        return SRx(#"^[1-9]\d{0,5}$"#).test(n) ? Int(n)! : -1
    }

    /// The pictures a box mark names: its own `crop` and each of its asks', each once.
    public static func cropsOf(_ mark: JSONValue?) -> [String] {
        guard let mark, mark.object != nil else { return [] }
        let all = [mark["crop"]?.string] + (mark["asks"]?.array ?? []).map { $0["crop"]?.string }
        var seen: [String] = []
        for c in all { if let c, cropRx.test(c), !seen.contains(c) { seen.append(c) } }
        return seen
    }

    /// The name a resized box's new picture takes: one past the highest of its pictures so far.
    public static func nextCropName(_ mark: JSONValue) -> String {
        let id = mark["id"]?.string ?? ""
        let n = max(0, cropsOf(mark).map { cropNumber(id, $0) }.max() ?? 0)
        return "crops/\(id)-\(n + 1).png"
    }

    public static func handlesOf(x: Double, y: Double, w: Double, h: Double) -> [(name: String, x: Double, y: Double)] {
        handles.map { (name: $0.0, x: x + $0.1 * w, y: y + $0.2 * h) }
    }

    /// Where a selected box's card goes: right, else left, level with the box's top; else under it at its left edge, else
    /// over it, else against the page's right edge. Inside the page; nil when the box is out of view.
    public static func cardPlace(box: CGRect, page: CGRect, size: CGSize, gap: CGFloat = 8) -> CGRect? {
        for v in [box.width, box.height, page.width, page.height, size.width, size.height] where !v.isFinite { return nil }
        if box.maxX <= page.minX || box.minX >= page.maxX || box.maxY <= page.minY || box.minY >= page.maxY { return nil }
        let width = min(size.width, page.width), height = min(size.height, page.height)
        let right = box.maxX + gap, left = box.minX - gap - width
        func inX(_ x: CGFloat) -> CGFloat { max(page.minX, min(x, page.maxX - width)) }
        func inY(_ y: CGFloat) -> CGFloat { max(page.minY, min(y, page.maxY - height)) }
        func at(_ x: CGFloat, _ y: CGFloat) -> CGRect { CGRect(x: inX(x).jsRounded, y: inY(y).jsRounded, width: width.jsRounded, height: height.jsRounded) }
        if right + width <= page.maxX { return at(right, box.minY) }
        if left >= page.minX { return at(left, box.minY) }
        let below = box.maxY + gap, above = box.minY - gap - height
        if below + height <= page.maxY { return at(box.minX, below) }
        if above >= page.minY { return at(box.minX, above) }
        return at(page.maxX - width, box.minY)
    }

    static func fmt(_ v: Double) -> String {
        if v == v.jsRounded && abs(v) < 1e15 { return String(Int(v)) }
        var s = String(v)
        if s.hasSuffix(".0") { s.removeLast(2) }
        return s
    }
    static func r1(_ v: Double) -> Double { (v * 10).jsRounded / 10 }
    static func r2(_ v: Double) -> Double { (v * 100).jsRounded / 100 }

    /// The rule that draws `rects` (html's containing block, CSS pixels): '' when there is nothing to draw.
    public static func boxesCss(_ rects: [BrowserRules.BoxReport.Item], selected: String? = nil, size: BrowserRules.Viewport? = nil, resizing: String? = nil, notes: [BrowserRules.BoxReport.Note] = []) -> String {
        let shown = rects.filter { [$0.x, $0.y, $0.w, $0.h].allSatisfy { $0.isFinite && abs($0) <= 1e6 } && $0.w > 0 && $0.h > 0 }.prefix(maxBoxes)
        let chips = notes.filter { [$0.x, $0.y, $0.size].allSatisfy { $0.isFinite } && $0.size > 0 && $0.size <= 64 }.prefix(maxNotes)
        if shown.isEmpty && chips.isEmpty { return "" }
        let all: [(Double, Double, Double, Double)] = shown.map { ($0.x, $0.y, $0.w, $0.h) } + chips.map { ($0.x, $0.y, $0.size, $0.size) }
        let maxW = (size?.width ?? 0) > 0 ? size!.width : .infinity, maxH = (size?.height ?? 0) > 0 ? size!.height : .infinity
        let left = (all.map { $0.0 }.min()! - pad).rounded(.down), top = (all.map { $0.1 }.min()! - pad).rounded(.down)
        let right = min(maxW, (all.map { $0.0 + $0.2 }.max()! + pad).rounded(.up)), bottom = min(maxH, (all.map { $0.1 + $0.3 }.max()! + pad).rounded(.up))
        let W = max(1, right - left), H = max(1, bottom - top)
        var shapes = ""
        for r in shown {
            let x = (r.x - left).jsRounded, y = (r.y - top).jsRounded
            let w = max(1, r.w.jsRounded), h = max(1, r.h.jsRounded)
            let haloRect = "<rect x=\"\(fmt(x - 0.5))\" y=\"\(fmt(y - 0.5))\" width=\"\(fmt(w + 1))\" height=\"\(fmt(h + 1))\" fill=\"none\" stroke=\"\(halo)\" stroke-width=\"1\"/>"
            let tinted = resizing != nil && r.id == resizing
            let outline = haloRect + "<rect x=\"\(fmt(x + 0.5))\" y=\"\(fmt(y + 0.5))\" width=\"\(fmt(max(0, w - 1)))\" height=\"\(fmt(max(0, h - 1)))\" fill=\"\(tinted ? tint : "none")\" stroke=\"\(line)\" stroke-width=\"1\"/>"
            if tinted || r.id != selected { shapes += outline; continue }
            let half = (handle - 1) / 2
            let hs = handlesOf(x: x, y: y, w: w, h: h).map { p in
                "<rect x=\"\(fmt(p.x.jsRounded - half))\" y=\"\(fmt(p.y.jsRounded - half))\" width=\"\(fmt(handle - 1))\" height=\"\(fmt(handle - 1))\" fill=\"\(line)\" stroke=\"\(halo)\" stroke-width=\"1\"/>"
            }
            shapes += outline + hs.joined()
        }
        shapes += chips.map { noteChip(x: $0.x - left, y: $0.y - top, size: $0.size) }.joined()
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"\(fmt(W))\" height=\"\(fmt(H))\" viewBox=\"0 0 \(fmt(W)) \(fmt(H))\" shape-rendering=\"crispEdges\">\(shapes)</svg>"
        let url = "data:image/svg+xml,\(JSStr.encodeURIComponent(svg))"
        let rule = ["content:\"\"", "display:block", "position:absolute", "left:\(fmt(left))px", "top:\(fmt(top))px", "width:\(fmt(W))px", "height:\(fmt(H))px",
                    "margin:0", "padding:0", "border:0", "transform:none", "opacity:1", "visibility:visible", "pointer-events:none", "z-index:2147483647",
                    "background:url(\"\(url)\") no-repeat 0 0 / \(fmt(W))px \(fmt(H))px"].map { "\($0) !important" }.joined(separator: ";")
        return "html::after{\(rule)}"
    }

    /// A note's symbol at (x, y), `size` across: a disc in Engelbart's blue with a white ring and three short white lines.
    public static func noteChip(x: Double, y: Double, size: Double) -> String {
        let r = size / 2, cx = r1(x + r), cy = r1(y + r), k = size / 16
        func ln(_ dy: Double, _ w: Double) -> String { "M\(fmt(r2(cx - 3.5 * k))) \(fmt(r2(cy + dy * k)))h\(fmt(r2(w * k)))" }
        return "<g shape-rendering=\"geometricPrecision\"><circle cx=\"\(fmt(cx))\" cy=\"\(fmt(cy))\" r=\"\(fmt(r - 0.5))\" fill=\"\(noteChipColor)\" stroke=\"#fff\" stroke-width=\"1\"/>"
            + "<path d=\"\(ln(-2.5, 7))\(ln(0, 7))\(ln(2.5, 4.5))\" fill=\"none\" stroke=\"#fff\" stroke-width=\"\(fmt(r2(1.4 * k)))\" stroke-linecap=\"round\"/></g>"
    }

    /// The numbers beside the pointer while a box is resized (one html::before rule, fixed in the viewport); '' for none.
    public static func readoutCss(x: Double, y: Double, w: Double, h: Double, zoom: Double = 1, viewport: BrowserRules.Viewport? = nil) -> String {
        guard [x, y, w, h].allSatisfy({ $0.isFinite }), zoom.isFinite, zoom > 0 else { return "" }
        let pts = [w, h].map { String(Int(max(0, ($0 * zoom).jsRounded))) }
        let gap = readoutGap / zoom, width = (Double(pts.map(\.count).max()!) * readoutDigit + readoutPad) / zoom, height = readoutHeight / zoom
        let vw = viewport?.width ?? .infinity, vh = viewport?.height ?? .infinity
        let right = x + gap + width <= vw, below = y + gap + height <= vh
        let left = r2(right ? x + gap : x - gap), top = r2(below ? y + gap : y - gap)
        let transform = "scale(\(fmt(((1 / zoom) * 1e4).jsRounded / 1e4))) translate(\(right ? "0" : "-100%"),\(below ? "0" : "-100%"))"
        let rule = ["content:\"\(pts[0])\\A \(pts[1])\"", "display:block", "position:fixed", "left:\(fmt(left))px", "top:\(fmt(top))px", "right:auto", "bottom:auto", "width:auto", "height:auto",
                    "margin:0", "border:0", "box-shadow:none", "filter:none", "clip-path:none", "mask:none", "mix-blend-mode:normal",
                    "opacity:1", "visibility:visible", "pointer-events:none", "z-index:2147483647", "text-transform:none", "text-indent:0", "text-decoration:none", "text-shadow:none",
                    "transform-origin:0 0", "transform:\(transform)"] + readoutCSS.components(separatedBy: ";")
        return "html::before{\(rule.map { "\($0) !important" }.joined(separator: ";"))}"
    }

    /// The cursor rule for a handle or an edge (views.cjs setCursor).
    public static let cursorValues: Set<String> = ["nwse-resize", "nesw-resize", "ns-resize", "ew-resize", "pointer"]
    public static func cursorCss(_ value: String) -> String { "html,html *,html *::before,html *::after{cursor:\(value) !important}" }
}

/// The drawing layer's readouts (src/main/browser/box-layer-preload.cjs), for the native layer.
public enum BoxLayerLook {
    public static let min: CGFloat = 6 // a smaller drag is a click
    public static let readoutGap: CGFloat = 10
    public static let cross: CGFloat = 20
    public static let circle: CGFloat = 12

    /// The two numbers the readout shows: the pointer's place before the press, the rectangle's size while dragging.
    public static func readout(dragging: Bool, screenX: CGFloat, screenY: CGFloat, w: CGFloat, h: CGFloat, scale: CGFloat = 1) -> [String] {
        let n: (CGFloat) -> String = { String(Int(($0 * scale).jsRounded)) }
        return dragging ? [n(w), n(h)] : [n(screenX), n(screenY)]
    }

    /// Where the readout's corner goes: below and right of the pointer, flipped near the layer's edges.
    public static func readoutAt(x: CGFloat, y: CGFloat, size: CGSize, view: CGSize, gap: CGFloat = readoutGap) -> CGPoint {
        let left = x + gap + size.width <= view.width ? x + gap : x - gap - size.width
        let top = y + gap + size.height <= view.height ? y + gap : y - gap - size.height
        return CGPoint(x: Swift.max(0, left), y: Swift.max(0, top))
    }
}

/// Where the card for a selection goes (src/shared/selection-card.cjs): under the selection's last line, left with it;
/// with no room, above its first line; with room nowhere, as far down as it fits. Inside the pane; nil once out of it.
public enum SelectionCardPlace {
    public static let gap: CGFloat = 8
    public static let cardWidth: CGFloat = 340
    public static let shade = (top: CGFloat(18), side: CGFloat(24), bottom: CGFloat(30))

    public static func place(line: CGRect?, all: CGRect?, pane: CGRect, size: CGSize, gap: CGFloat = gap) -> CGRect? {
        guard let line else { return nil }
        let sel = all ?? line
        if sel.maxX <= pane.minX || sel.minX >= pane.maxX || sel.maxY <= pane.minY || sel.minY >= pane.maxY { return nil }
        let width = max(0, min(size.width, pane.width)), height = max(0, min(size.height, pane.height))
        let x = max(pane.minX, min(line.minX, pane.maxX - width))
        let below = line.maxY + gap, above = min(sel.minY, line.minY) - gap - height
        let y: CGFloat
        if below >= pane.minY && below + height <= pane.maxY { y = below }
        else if above >= pane.minY && above + height <= pane.maxY { y = above }
        else { y = max(pane.minY, min(below, pane.maxY - height)) }
        return CGRect(x: x.jsRounded, y: y.jsRounded, width: width.jsRounded, height: height.jsRounded)
    }

    /// The view's place for a card `size` with `shade` about it (the shadow's room).
    public static func shaded(line: CGRect?, all: CGRect?, pane: CGRect, size: CGSize, shade: (top: CGFloat, side: CGFloat, bottom: CGFloat) = shade, gap: CGFloat = gap) -> CGRect? {
        guard let line, place(line: line, all: all, pane: pane, size: size, gap: gap) != nil else { return nil }
        let inner = CGRect(x: pane.minX + shade.side, y: pane.minY + shade.top, width: max(0, pane.width - 2 * shade.side), height: max(0, pane.height - shade.top - shade.bottom))
        guard let at = place(line: line, all: all, pane: inner, size: size, gap: gap) else {
            let x = max(inner.minX, min(line.minX, inner.maxX - size.width))
            let y = max(inner.minY, min(line.maxY + gap, inner.maxY - size.height))
            return CGRect(x: (x - shade.side).jsRounded, y: (y - shade.top).jsRounded, width: (min(size.width, inner.width) + 2 * shade.side).jsRounded, height: (min(size.height, inner.height) + shade.top + shade.bottom).jsRounded)
        }
        return CGRect(x: (at.minX - shade.side).jsRounded, y: (at.minY - shade.top).jsRounded, width: (at.width + 2 * shade.side).jsRounded, height: (at.height + shade.top + shade.bottom).jsRounded)
    }
}
