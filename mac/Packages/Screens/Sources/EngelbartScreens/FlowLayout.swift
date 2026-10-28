import EngelbartUI
import SwiftUI

/// `.title-lead` over a row padded `base` on the left: 84 (clear of the traffic lights) unless the window is full screen,
/// then the row's own padding (styles.css: the rule replaces the padding, `!important`, only off full screen).
struct TitleLeadReplacing: ViewModifier {
    @EnvironmentObject var chrome: WindowChrome
    let base: CGFloat
    func body(content: Content) -> some View { content.padding(.leading, chrome.fullScreen ? base : TitleBarMetrics.lead) }
}

extension View {
    func titleLead(replacing base: CGFloat) -> some View { modifier(TitleLeadReplacing(base: base)) }
}

/// `display: flex; flex-wrap: wrap; align-items: stretch` with each item its own width (its ideal, at least `minItem`,
/// at most the line): Home's project cards and Recently deleted. Items on a line are all given the line's height.
public struct FlowLayout: Layout {
    public var spacing: CGFloat
    public var minItem: CGFloat
    public var stretch: Bool

    public init(spacing: CGFloat, minItem: CGFloat = 0, stretch: Bool = true) { self.spacing = spacing; self.minItem = minItem; self.stretch = stretch }

    struct Line { var items: [(index: Int, size: CGSize)] = []; var height: CGFloat = 0 }

    func lines(_ subviews: Subviews, width: CGFloat) -> [Line] {
        var out: [Line] = []
        var line = Line()
        var x: CGFloat = 0
        for (i, view) in subviews.enumerated() {
            let ideal = view.sizeThatFits(.unspecified)
            let w = min(max(ideal.width, minItem), width)
            let h = view.sizeThatFits(ProposedViewSize(width: w, height: nil)).height
            if !line.items.isEmpty && x + spacing + w > width + 0.5 {
                out.append(line); line = Line(); x = 0
            }
            x += (line.items.isEmpty ? 0 : spacing) + w
            line.items.append((i, CGSize(width: w, height: h)))
            line.height = max(line.height, h)
        }
        if !line.items.isEmpty { out.append(line) }
        return out
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let all = lines(subviews, width: width.isFinite ? width : .greatestFiniteMagnitude)
        var height: CGFloat = 0
        var used: CGFloat = 0
        for (i, line) in all.enumerated() {
            height += line.height + (i > 0 ? spacing : 0)
            var w: CGFloat = 0
            for (j, item) in line.items.enumerated() { w += item.size.width + (j > 0 ? spacing : 0) }
            used = max(used, w)
        }
        return CGSize(width: width.isFinite ? width : used, height: height)
    }

    public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in lines(subviews, width: bounds.width) {
            var x = bounds.minX
            for item in line.items {
                let h = stretch ? line.height : item.size.height
                subviews[item.index].place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(width: item.size.width, height: h))
                x += item.size.width + spacing
            }
            y += line.height + spacing
        }
    }
}
