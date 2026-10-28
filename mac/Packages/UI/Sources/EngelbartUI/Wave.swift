import SwiftUI

// Work in progress said in words (wave.css .eb-wave, 2026-10-14; ui/wave.js): grey text (#a8a8a8) with a darker band
// (#171717 at 50%, its edges at 38% and 62%) moving through it from left to right, the way a model's "thinking" is shown.
// The gradient is 260% of the text's width and its position runs from 100% to 0% over 2 s on
// cubic-bezier(.45,.05,.55,.95), forever. The red variant is an import that needs the person. Reduced motion: still, the
// band in the middle (position 50%).
//
// wave.js puts every wave on the page's clock so a row drawn again goes on where the last drawing was: here every wave
// reads the same absolute clock, so a WaveText rebuilt mid-crossing picks up where the old one was.

public enum WaveTone: Sendable { case grey, red }

public enum WaveClock {
    public static let period: TimeInterval = 2
    /// background-position (1 → 0) at `date`, eased.
    public static func position(_ date: Date) -> Double {
        let p = Keyframe.phase(date, period: period)
        return 1 - Keyframe.bezier(p, 0.45, 0.05, 0.55, 0.95)
    }
    /// The gradient's start and end, in units of the text's width, for a background-position of `position` (1 … 0): the
    /// 260%-wide image is offset by position × (100% − 260%).
    public static func span(position: Double) -> (start: Double, end: Double) {
        let start = -1.6 * position
        return (start, start + 2.6)
    }
}

/// A line of text with the wave through it (`waveText(html)`): as wide as its words, one line, an ellipsis that waves too.
public struct WaveText: View {
    let text: String
    let tone: WaveTone
    let font: Font
    @Environment(\.accessibilityReduceMotion) private var reduce

    public init(_ text: String, tone: WaveTone = .grey, font: Font = Fonts.swiftUISans(13)) { self.text = text; self.tone = tone; self.font = font }

    public var body: some View {
        if reduce {
            label(position: 0.5)
        } else {
            TimelineView(.animation) { context in label(position: WaveClock.position(context.date)) }
        }
    }

    private func label(position: Double) -> some View {
        let (start, end) = WaveClock.span(position: position)
        let floor = Color(tone == .red ? Palette.waveRedFloor : Palette.waveFloor)
        let band = Color(tone == .red ? Palette.waveRedBand : Palette.ink)
        let gradient = LinearGradient(stops: [
            .init(color: floor, location: 0), .init(color: floor, location: 0.38), .init(color: band, location: 0.5),
            .init(color: floor, location: 0.62), .init(color: floor, location: 1),
        ], startPoint: UnitPoint(x: start, y: 0.5), endPoint: UnitPoint(x: end, y: 0.5))
        return Text(text)
            .font(font)
            .lineLimit(1)
            .truncationMode(.tail)
            .foregroundStyle(gradient)
            .accessibilityLabel(text)
    }
}
