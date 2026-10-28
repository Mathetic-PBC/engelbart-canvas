import CoreGraphics
import Foundation

// Where a card sits (src/main/post-its/geometry.cjs). A card's preferred place is normalized (nx, ny in 0…1 of the room
// the window leaves it) with a preferred size in CSS pixels; the window clamps it on screen without ever writing the
// clamp back, so a small window loses nothing. Native bounds are CSS pixels times the zoom (1 unless the app scales).
// Everything here is in the overlay's coordinates: the window's content, y down.

/// A rect as geometry.cjs passes them: { x, y, width, height }, y down.
public struct PRect: Equatable, Sendable, Codable {
    public var x: Double, y: Double, width: Double, height: Double
    public init(x: Double, y: Double, width: Double, height: Double) { self.x = x; self.y = y; self.width = width; self.height = height }
    public init(_ r: CGRect) { self.init(x: Double(r.minX), y: Double(r.minY), width: Double(r.width), height: Double(r.height)) }
    public var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

/// A card's preferred layout (the post_its row's nx, ny, width, height).
public struct CardLayout: Equatable, Sendable {
    public var nx: Double, ny: Double, width: Double, height: Double
    public init(nx: Double, ny: Double, width: Double, height: Double) { self.nx = nx; self.ny = ny; self.width = width; self.height = height }
}

/// A menu or dialog over the window (`post-its:block`); `cover` marks one that covers the cards rather than moving them.
public struct BlockRect: Equatable, Sendable {
    public var rect: PRect
    public var cover: Bool
    public init(_ rect: PRect, cover: Bool = false) { self.rect = rect; self.cover = cover }
}

public struct GeometryError: Error, LocalizedError, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public enum PostItGeometry {
    static func clamp(_ n: Double, _ lo: Double, _ hi: Double) -> Double { max(lo, min(hi, n)) }
    /// JavaScript's Math.round (halves go up).
    static func round(_ n: Double) -> Double { (n + 0.5).rounded(.down) }
    public static let MARGIN = 8.0
    /// Leave the window controls and project navigation reachable.
    public static let TOP = 56.0
    /// A card crumples on its way to the trash (2026-09-22): from REACH CSS pixels out it shrinks towards SMALLEST of its
    /// size and slides off to the can's right, so the can stays in sight while it takes it.
    public static let REACH = 220.0
    public static let SMALLEST = 0.28

    /// Preferred size is CSS pixels; native bounds and the viewport are points (CSS × zoom).
    public static func cardBounds(_ row: CardLayout, viewport: CGSize, zoom: Double = 1) -> PRect {
        let w = Double(viewport.width) / zoom, h = Double(viewport.height) / zoom
        let width = max(1, min(row.width, w - 2 * MARGIN))
        let height = max(1, min(row.height, h - TOP - MARGIN))
        return PRect(
            x: round((MARGIN + row.nx * max(0, w - width - 2 * MARGIN)) * zoom),
            y: round((TOP + row.ny * max(0, h - height - TOP - MARGIN)) * zoom),
            width: round(width * zoom), height: round(height * zoom))
    }

    public static func layoutFromBounds(_ bounds: PRect, viewport: CGSize, zoom: Double = 1) -> CardLayout {
        let width = bounds.width / zoom, height = bounds.height / zoom
        return CardLayout(
            nx: clamp((bounds.x / zoom - MARGIN) / max(1, Double(viewport.width) / zoom - width - 2 * MARGIN), 0, 1),
            ny: clamp((bounds.y / zoom - TOP) / max(1, Double(viewport.height) / zoom - height - TOP - MARGIN), 0, 1),
            width: clamp(width, 180, 2400), height: clamp(height, 140, 2400))
    }

    /// The trash is the sidebar's foot (2026-09-22, wherever the sidebar puts it), measured in CSS pixels of the window's
    /// content (`rect`, nil when no workspace shows one); the pointer comes in points, CSS pixels times the zoom.
    public static func inTrash(_ point: CGPoint, _ rect: PRect?, zoom: Double = 1) -> Bool {
        guard let rect else { return false }
        let x = Double(point.x) / zoom, y = Double(point.y) / zoom
        return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
    }

    /// A rect the window sent, or nil: four finite numbers, inside any window there could be.
    public static func trashRect(_ value: PRect?) throws -> PRect? {
        guard let value else { return nil }
        let fields = [value.x, value.y, value.width, value.height]
        guard fields.allSatisfy({ $0.isFinite && abs($0) < 100_000 }), value.width > 0, value.height > 0 else { throw GeometryError("Invalid trash rect") }
        return value
    }

    /// 0 at REACH or farther from the can, 1 touching or over it (eased); `point` in points.
    public static func crumpleAmount(_ point: CGPoint, _ rect: PRect?, zoom: Double = 1) -> Double {
        guard let rect else { return 0 }
        let x = Double(point.x) / zoom, y = Double(point.y) / zoom
        let dx = max(rect.x - x, 0, x - (rect.x + rect.width))
        let dy = max(rect.y - y, 0, y - (rect.y + rect.height))
        let t = clamp(1 - hypot(dx, dy) / REACH, 0, 1)
        return t * t * (3 - 2 * t)
    }

    /// Where a dragged card sits: `size` its uncrumpled points, `grab` the fraction of it under the pointer when the drag
    /// began, `point` the pointer, `t` from crumpleAmount. At t = 0 the grabbed spot stays under the pointer; at t = 1 the
    /// card is SMALLEST of its size, centred on the pointer's height, left edge past the can.
    public static func draggedBounds(point: CGPoint, grab: CGPoint, size: CGSize, t: Double, rect: PRect?, zoom: Double = 1) -> (scale: Double, bounds: PRect) {
        let scale = 1 - (1 - SMALLEST) * t
        let width = Double(size.width) * scale, height = Double(size.height) * scale
        let px = Double(point.x), py = Double(point.y)
        let held = (x: px - Double(grab.x) * width, y: py - Double(grab.y) * height)
        let beside = rect.map { max(px + 14 * zoom, ($0.x + $0.width + 10) * zoom) } ?? px + 14 * zoom
        let aside = (x: beside, y: py - height / 2)
        return (scale, PRect(x: round(held.x + (aside.x - held.x) * t), y: round(held.y + (aside.y - held.y) * t),
                             width: max(1, round(width)), height: max(1, round(height))))
    }

    /// Whether two rects overlap (touching edges do not).
    public static func overlaps(_ a: PRect, _ b: PRect) -> Bool {
        a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    }

    /// The app's own menus and dialogs as measured: at most 64, all finite. One marked `cover` covers the cards under it.
    public static func blockingRects(_ value: [BlockRect]) throws -> [BlockRect] {
        guard value.count <= 64 else { throw GeometryError("Blocking rects must be a list of at most 64") }
        return try value.map { BlockRect(try trashRect($0.rect)!, cover: $0.cover) }
    }

    /// The tallest a card can show in this window (CSS px): the preferred height is clamped to it on screen.
    public static func tallest(viewport: CGSize, zoom: Double = 1) -> Double {
        max(140, min(2400, Double(viewport.height) / zoom - TOP - MARGIN))
    }

    /// A card that grows to fit its text (2026-09-22) keeps its top edge where it is, unless the window's bottom is in the
    /// way, and then it moves up. → the layout, height clamped to the window.
    public static func grown(_ row: CardLayout, height: Double, viewport: CGSize, zoom: Double = 1) -> CardLayout {
        let now = cardBounds(row, viewport: viewport, zoom: zoom)
        let h = clamp(height, 140, tallest(viewport: viewport, zoom: zoom))
        let next = layoutFromBounds(PRect(x: now.x, y: now.y, width: now.width, height: h * zoom), viewport: viewport, zoom: zoom)
        return CardLayout(nx: row.nx, ny: next.ny, width: row.width, height: next.height)
    }
}
