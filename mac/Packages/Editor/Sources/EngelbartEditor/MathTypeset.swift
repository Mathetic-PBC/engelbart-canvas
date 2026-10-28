import AppKit
import EngelbartDoc
import SwiftMath

// Math typeset as KaTeX drew it in Electron (doc.js renderMath): fractions stacked, roots, matrices, big operators, sub-
// and superscript stacks. SwiftMath (MTMathImage) lays the LaTeX out with its OpenType math font and gives an image; the
// editor puts it in the line as one attachment, sitting on the text's baseline by the formula's descent. LaTeX SwiftMath
// cannot parse falls back to EngelbartDoc.MathText's Unicode text, and LaTeX neither can read shows as code, as a KaTeX
// error did.

enum MathTypeset {
    struct Drawn { let image: NSImage; let size: CGSize; let descent: CGFloat }

    private static var cache: [String: Drawn?] = [:]
    private static var order: [String] = []

    /// Whether SwiftMath reads `tex`.
    static func parses(_ tex: String) -> Bool {
        var error: NSError?
        return MTMathListBuilder.build(fromString: tex, error: &error) != nil && error == nil
    }

    /// `tex` typeset at `size` (display: `$$…$$` style, else inline text style), cached (500, as MATH_CACHE was).
    static func draw(_ tex: String, display: Bool, size: CGFloat, color: NSColor = Look.ink) -> Drawn? {
        let key = "\(display ? "D" : "I")\(size)\(color.hashValue)\(tex)"
        if let hit = cache[key] { return hit }
        var drawn: Drawn? = nil
        if !tex.trimmed.isEmpty, parses(tex) {
            let mode: MTMathUILabelMode = display ? .display : .text
            let img = MTMathImage(latex: tex, fontSize: size, textColor: color, labelMode: mode, textAlignment: .left)
            let (error, image) = img.asImage()
            if error == nil, let image, image.size.width > 0 {
                // The descent, for the baseline: the label lays out the same list and says it.
                let label = MTMathUILabel()
                label.latex = tex; label.fontSize = size; label.labelMode = mode
                label.frame = NSRect(origin: .zero, size: label.intrinsicContentSize)
                label.layout()
                let descent = label.displayList?.descent ?? image.size.height * 0.25
                drawn = Drawn(image: image, size: image.size, descent: descent)
            }
        }
        if cache.count >= 500, let first = order.first { cache[first] = nil; order.removeFirst() }
        cache[key] = .some(drawn); order.append(key)
        return drawn
    }

    /// The formula as one attachment character, on the baseline.
    static func attachment(_ tex: String, display: Bool, size: CGFloat, color: NSColor = Look.ink) -> NSAttributedString? {
        guard let d = draw(tex, display: display, size: size, color: color) else { return nil }
        let a = NSTextAttachment()
        a.image = d.image
        a.bounds = CGRect(x: 0, y: -d.descent, width: d.size.width, height: d.size.height)
        return NSAttributedString(attachment: a)
    }
}
