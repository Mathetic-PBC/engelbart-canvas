import SwiftUI

// The CSS keyframes (styles.css, tokens/effects.css) as SwiftUI modifiers. Each says which rule it is.

/// `@keyframes rise`: from opacity 0 and 6px down to where it belongs, `--ease-rise`. Popups use 120, 160 or 200 ms; the
/// step entrance 260 (`--dur-rise`).
struct RiseModifier: ViewModifier {
    let duration: TimeInterval
    @State private var shown = false
    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 6)
            .onAppear { withAnimation(Motion.ease(duration)) { shown = true } }
    }
}

/// A repeating keyframe driven by the shared clock, so two views started at different times stay in step (wave.js's
/// reason for putting every wave on the page's clock).
public struct Keyframe {
    /// 0…1 through a `period`-second cycle, measured from the app's one clock.
    public static func phase(_ date: Date, period: TimeInterval, delay: TimeInterval = 0) -> Double {
        let t = date.timeIntervalSinceReferenceDate - delay
        let p = t.truncatingRemainder(dividingBy: period) / period
        return p < 0 ? p + 1 : p
    }

    /// CSS `ease-in-out` (cubic-bezier(.42,0,.58,1)) at x.
    public static func easeInOut(_ x: Double) -> Double { bezier(x, 0.42, 0, 0.58, 1) }

    /// The y of a cubic-bezier timing function at progress x (Newton steps on x(t)).
    public static func bezier(_ x: Double, _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> Double {
        if x <= 0 { return 0 }
        if x >= 1 { return 1 }
        func sample(_ t: Double, _ a1: Double, _ a2: Double) -> Double {
            let u = 1 - t
            return 3 * u * u * t * a1 + 3 * u * t * t * a2 + t * t * t
        }
        var t = x
        for _ in 0..<8 {
            let xt = sample(t, x1, x2) - x
            let dx = 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2)
            if abs(dx) < 1e-6 { break }
            t = min(1, max(0, t - xt / dx))
        }
        return sample(t, y1, y2)
    }

    /// Linear interpolation through keyframe stops [(offset 0…1, value)], each segment eased by `ease`.
    public static func value(at p: Double, stops: [(Double, Double)], ease: (Double) -> Double = easeInOut) -> Double {
        guard let first = stops.first else { return 0 }
        if p <= first.0 { return first.1 }
        for i in 1..<stops.count {
            let (o0, v0) = stops[i - 1], (o1, v1) = stops[i]
            if p <= o1 {
                let local = o1 == o0 ? 1 : (p - o0) / (o1 - o0)
                return v0 + (v1 - v0) * ease(local)
            }
        }
        return stops.last!.1
    }
}

/// `@keyframes pulse` / `eng-pulse` and friends: opacity following stops on the shared clock.
struct PulseModifier: ViewModifier {
    let period: TimeInterval
    let delay: TimeInterval
    let stops: [(Double, Double)]
    @Environment(\.accessibilityReduceMotion) private var reduce
    func body(content: Content) -> some View {
        if reduce {
            content.opacity(stops.map(\.1).max() ?? 1)
        } else {
            TimelineView(.animation) { context in
                content.opacity(Keyframe.value(at: Keyframe.phase(context.date, period: period, delay: delay), stops: stops))
            }
        }
    }
}

/// `connection-spin`: one turn every .9 s, linear; still with reduced motion.
struct SpinModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduce
    func body(content: Content) -> some View {
        if reduce { content } else {
            TimelineView(.animation) { context in
                content.rotationEffect(.degrees(360 * Keyframe.phase(context.date, period: 0.9)))
            }
        }
    }
}

/// `@keyframes added` (blue100 → clear) and `ask-flash` (#fff1b8 held 45% of 2.4 s, then clear): a fill that fades out
/// once when `trigger` changes.
struct FlashModifier<T: Equatable>: ViewModifier {
    let color: NSColor
    let hold: Double
    let duration: TimeInterval
    let trigger: T
    @State private var start: Date? = nil
    func body(content: Content) -> some View {
        content.background {
            if let start {
                TimelineView(.animation) { context in
                    let p = min(1, context.date.timeIntervalSince(start) / duration)
                    let a = p <= hold ? 1 : 1 - Keyframe.easeInOut((p - hold) / (1 - hold))
                    RoundedRectangle(cornerRadius: 4).fill(Color(color).opacity(a))
                }
            }
        }
        .onChange(of: trigger) { _, _ in
            start = Date()
            DispatchQueue.main.asyncAfter(deadline: .now() + duration) { start = nil }
        }
    }
}

public extension View {
    /// The `rise` entrance (`animation: rise <ms> cubic-bezier(.25,.1,.25,1)`).
    func rise(_ duration: TimeInterval = Motion.rise) -> some View { modifier(RiseModifier(duration: duration)) }
    /// `blink` (a caret): opacity 0 for the second half of each second.
    func blink(period: TimeInterval = 1) -> some View { modifier(PulseModifier(period: period, delay: 0, stops: [(0, 1), (0.4999, 1), (0.5, 0), (0.9999, 0), (1, 1)])) }
    /// `pulse` (tokens/effects.css): .18 → 1 at 35% → .18 at 70%.
    func pulse(period: TimeInterval = 1.1, delay: TimeInterval = 0) -> some View {
        modifier(PulseModifier(period: period, delay: delay, stops: [(0, 0.18), (0.35, 1), (0.7, 0.18), (1, 0.18)]))
    }
    /// `github-wait`: opacity .25 ↔ 1 over 1.2 s.
    func waiting() -> some View { modifier(PulseModifier(period: 1.2, delay: 0, stops: [(0, 0.25), (0.5, 1), (1, 0.25)])) }
    /// `connection-spin`.
    func spinning() -> some View { modifier(SpinModifier()) }
    /// `added`: a blue100 flash fading to nothing whenever `trigger` changes.
    func addedFlash<T: Equatable>(_ trigger: T, duration: TimeInterval = 1.2) -> some View {
        modifier(FlashModifier(color: Palette.accHovBg, hold: 0, duration: duration, trigger: trigger))
    }
    /// `ask-flash` (the Agent Viewer's "show line"): #fff1b8 held 45% of 2.4 s, then fading.
    func askFlash<T: Equatable>(_ trigger: T) -> some View {
        modifier(FlashModifier(color: Palette.flash, hold: 0.45, duration: 2.4, trigger: trigger))
    }
}
