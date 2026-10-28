import SwiftUI

// A tab drawn as the Stage draws its own (ui/FluidTab.jsx; Add - Mention Stage.dc.html, 2026-09-23), for the strips that
// are not the Stage's: the document's tabs over the middle canvas and the Terminal's (2026-09-25, "make the styles match
// stage"). The one in front is white and runs into what is under it, its foot flaring out; the rest have no box until
// hovered, a hairline between two of them. These are as long as their titles, up to TAB_MAX ("make the tab lengths match
// their title or the max note title length"), and shrink together only when the strip fills.

public enum FluidTabMetrics {
    public static let max: CGFloat = 220 // TAB_MAX
    public static let min: CGFloat = 44
    public static let height: CGFloat = 34
    public static let fade: CGFloat = 18
}

/// The flared foot beside the tab in front: a 10×10 white square with a quarter circle (radius 10) taken out of its top
/// corner on the tab's far side (`radial-gradient(circle at 0 0, transparent 9.5px, #fff 10px)`).
struct TabFoot: Shape {
    let left: Bool
    /// What is left of the square once the quarter circle is out: the corner by the tab, bounded by the arc.
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let r = rect.width
        if left {
            // Circle at the top left; the white is the bottom-right corner (beside the tab).
            p.move(to: CGPoint(x: rect.maxX, y: rect.minY))
            p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            p.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
            p.addArc(center: CGPoint(x: rect.minX, y: rect.minY), radius: r, startAngle: .degrees(90), endAngle: .degrees(0), clockwise: true)
        } else {
            // Circle at the top right; the white is the bottom-left corner.
            p.move(to: CGPoint(x: rect.minX, y: rect.minY))
            p.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
            p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            p.addArc(center: CGPoint(x: rect.maxX, y: rect.minY), radius: r, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        }
        p.closeSubpath()
        return p
    }
}

/// The tab itself. Its content is laid out in a row (gap 8): usually a TabTitle and a TabClose.
public struct FluidTab<Content: View>: View {
    let on: Bool
    let sep: Bool
    let lifted: Bool
    let content: Content
    @State private var hov = false

    public init(on: Bool, sep: Bool = false, lifted: Bool = false, @ViewBuilder content: () -> Content) {
        self.on = on; self.sep = sep; self.lifted = lifted; self.content = content()
    }

    public var body: some View {
        ZStack(alignment: .topTrailing) {
            if on {
                HStack(spacing: 8) { content }
                    .padding(.leading, 12).padding(.trailing, 6)
                    .frame(maxHeight: .infinity)
                    .background(UnevenRoundedRectangle(topLeadingRadius: 10, topTrailingRadius: 10).fill(Color.white))
                    .background(alignment: .bottomLeading) {
                        TabFoot(left: true).fill(Color.white).frame(width: 10, height: 10).offset(x: -10)
                    }
                    .background(alignment: .bottomTrailing) {
                        TabFoot(left: false).fill(Color.white).frame(width: 10, height: 10).offset(x: 10)
                    }
            } else {
                HStack(spacing: 8) { content }
                    .padding(.leading, 10).padding(.trailing, 4)
                    .frame(maxHeight: .infinity)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color(lifted || hov ? Palette.tabHover : .clear)))
                    .padding(.horizontal, 2).padding(.bottom, 4)
                    .onHover { hov = $0 }
                    .animation(.easeOut(duration: Motion.fast), value: hov)
            }
            if sep {
                Rectangle().fill(Color(Palette.bd2)).frame(width: 1, height: 16).padding(.top, 9)
            }
        }
        .frame(minWidth: FluidTabMetrics.min, maxWidth: FluidTabMetrics.max, minHeight: FluidTabMetrics.height, maxHeight: FluidTabMetrics.height, alignment: .leading)
        .zIndex(lifted ? 2 : on ? 1 : 0)
        .contentShape(Rectangle())
    }
}

/// A tab's name: it fades out over its last 18px only when the tab is too short for it, so a whole name never loses its
/// last letters.
public struct TabTitle: View {
    let text: String
    let weight: Int
    let color: NSColor
    @State private var natural: CGFloat = 0
    @State private var shown: CGFloat = 0

    public init(_ text: String, weight: Int = 400, color: NSColor = Palette.mut) { self.text = text; self.weight = weight; self.color = color }

    public static func clipped(natural: CGFloat, shown: CGFloat) -> Bool { natural > shown + 1 }

    public var body: some View {
        let clipped = Self.clipped(natural: natural, shown: shown)
        // The whole name at its own width, cut by the box (no ellipsis: CSS overflow hidden + the fade).
        Text(text)
            .textStyle(TextStyle(12.5, weight: weight, lineHeight: 1.3))
            .foregroundStyle(Color(color))
            .lineLimit(1)
            .fixedSize()
            .background(GeometryReader { g in Color.clear.onAppear { natural = g.size.width }.onChange(of: g.size.width) { _, w in natural = w } })
            .frame(minWidth: 0, maxWidth: natural > 0 ? natural : nil, alignment: .leading)
            .clipped()
            .layoutPriority(-1)
            .background(GeometryReader { g in Color.clear.onAppear { shown = g.size.width }.onChange(of: g.size.width) { _, w in shown = w } })
            .mask {
                if clipped {
                    GeometryReader { g in
                        LinearGradient(stops: [.init(color: .black, location: 0),
                                               .init(color: .black, location: max(0, (g.size.width - FluidTabMetrics.fade) / max(1, g.size.width))),
                                               .init(color: .clear, location: 1)], startPoint: .leading, endPoint: .trailing)
                    }
                } else {
                    Rectangle()
                }
            }
    }
}

/// The tab's ×: 20×20, round, 14px #8f8f8f; under the pointer #e3e3e3 with ink. Its press never reaches the tab.
public struct TabClose: View {
    let label: String
    let title: String
    let onClose: () -> Void
    public init(label: String = "Close tab", title: String = "⌘W", onClose: @escaping () -> Void) { self.label = label; self.title = title; self.onClose = onClose }
    public var body: some View {
        Button(action: onClose) {
            Text("×").font(Fonts.swiftUISans(14)).frame(width: 20, height: 20)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color(Palette.fnt))
        .hover(.closeX, shape: Circle())
        .help(title)
        .accessibilityLabel(label)
    }
}

/// When a tab's card shows (useTabCard in FluidTab.jsx): after 650 ms under the pointer, or 60 ms while "warm" (a card
/// was shown and the pointer left less than 400 ms ago); gone at once when the pointer leaves. The card is 260 wide at the
/// tab's left + 4, kept 8 inside the window, 6 below the tab.
@MainActor
public final class TabCardTimer: ObservableObject {
    public struct Card: Equatable { public var id: String; public var left: CGFloat; public var top: CGFloat; public var width: CGFloat }
    public static let firstMs: TimeInterval = 0.65, warmMs: TimeInterval = 0.06, coolMs: TimeInterval = 0.4, width: CGFloat = 260

    @Published public private(set) var card: Card? = nil
    private var timer: DispatchWorkItem?
    private var cool: DispatchWorkItem?
    public private(set) var warm = false
    private let schedule: (TimeInterval, DispatchWorkItem) -> Void

    public init(schedule: @escaping (TimeInterval, DispatchWorkItem) -> Void = { delay, work in DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work) }) {
        self.schedule = schedule
    }

    /// The pointer came onto tab `id`, whose rect (window coordinates, y down) is `rect`, in a window `windowWidth` wide.
    public func enter(id: String, rect: CGRect, windowWidth: CGFloat) {
        timer?.cancel()
        let width = Self.width
        let left = max(8, min(rect.minX + 4, windowWidth - width - 8))
        let next = Card(id: id, left: left, top: rect.maxY + 6, width: width)
        let work = DispatchWorkItem { [weak self] in self?.warm = true; self?.card = next }
        timer = work
        schedule(warm ? Self.warmMs : Self.firstMs, work)
    }

    public func leave() {
        timer?.cancel()
        card = nil
        cool?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.warm = false }
        cool = work
        schedule(Self.coolMs, work)
    }

    public func hide() { timer?.cancel(); card = nil }
}

/// The card a tab shows: its whole name and where it is. #c9c9c9 border, radius 8, padding 10×12, rise 160 ms, never
/// takes the pointer.
public struct TabCardView: View {
    let title: String
    let detail: String?
    public init(title: String, detail: String? = nil) { self.title = title; self.detail = detail }
    public var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).textStyle(TextStyle(13, weight: 500, lineHeight: 1.4)).foregroundStyle(Color(Palette.ink)).fixedSize(horizontal: false, vertical: true)
            if let detail, !detail.isEmpty {
                Text(detail).textStyle(TextStyle(12, lineHeight: 1.4)).foregroundStyle(Color(Palette.fnt)).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))
        .frame(width: TabCardTimer.width, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(Palette.bd2), lineWidth: 1))
        .allowsHitTesting(false)
        .rise(0.16)
    }
}
