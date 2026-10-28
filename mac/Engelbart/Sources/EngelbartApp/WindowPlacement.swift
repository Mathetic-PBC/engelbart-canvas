import CoreGraphics
import Foundation

// Pure window geometry and validation, ported with their tests: placement (windows.cjs:31-43), resizedBounds
// (window-edges.cjs), cleanPlace (windows.cjs:24-28), parseExternalUrl (ipc-validation.cjs:22-36). Rects here are y-down
// (Electron's screen coordinates: the top of the main display is 0); WindowGeometry converts to and from AppKit's.

/// Where a window is: its project and workspace; projectId nil on the projects screen.
public struct WindowPlace: Equatable, Codable, Sendable {
    public var projectId: String?
    public var workspaceId: String?
    public init(projectId: String? = nil, workspaceId: String? = nil) { self.projectId = projectId; self.workspaceId = workspaceId }

    static let uuid = try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: [.caseInsensitive])
    static func idOrNil(_ value: String?) -> String? {
        guard let value, uuid.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil else { return nil }
        return value
    }

    /// Only UUIDs are kept; no workspace without a project.
    public static func clean(projectId: String?, workspaceId: String?) -> WindowPlace {
        let project = idOrNil(projectId)
        return WindowPlace(projectId: project, workspaceId: project != nil ? idOrNil(workspaceId) : nil)
    }
}

/// What a window opens on (its first start, or a reload): its place, the projects screen, or nil (the app decides).
public enum WindowTarget: Equatable, Sendable {
    case home
    case place(WindowPlace)
}

/// A saved window: its place and bounds (y-down screen points).
public struct SavedWindow: Equatable, Codable, Sendable {
    public var projectId: String?
    public var workspaceId: String?
    public var bounds: Rect?
    public init(projectId: String?, workspaceId: String?, bounds: Rect?) { self.projectId = projectId; self.workspaceId = workspaceId; self.bounds = bounds }
    public var place: WindowPlace { WindowPlace(projectId: projectId, workspaceId: workspaceId) }

    /// `{ x, y, width, height }` as state.json keeps it.
    public struct Rect: Equatable, Codable, Sendable {
        public var x: Double, y: Double, width: Double, height: Double
        public init(x: Double, y: Double, width: Double, height: Double) { self.x = x; self.y = y; self.width = width; self.height = height }
        public init(_ r: CGRect) { self.init(x: Double(r.minX), y: Double(r.minY), width: Double(r.width), height: Double(r.height)) }
        public var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
        /// Each field rounded, as projects.cjs writeWindows keeps them (Math.round).
        public static func rounded(_ r: CGRect) -> Rect {
            Rect(x: Double(r.minX).rounded(), y: Double(r.minY).rounded(), width: Double(r.width).rounded(), height: Double(r.height).rounded())
        }
    }
}

public enum WindowGeometry {
    public static let minSize = CGSize(width: 900, height: 560)
    public static let defaultSize = CGSize(width: 1440, height: 900)

    /// A placement: an origin (y-down) when it has one, else centred at `size`.
    public struct Placed: Equatable, Sendable {
        public var origin: CGPoint?
        public var size: CGSize
    }

    /// Saved bounds when enough of them (200 × 120) is on a work area, else that size, centred; a window opened from
    /// another 24 down and to the right of it; else the default size, centred. Never below the minimum.
    public static func placement(bounds: CGRect? = nil, from: CGRect? = nil, workAreas: [CGRect], min: CGSize = minSize,
                                 size: CGSize = defaultSize) -> Placed {
        func onScreen(_ r: CGRect) -> Bool {
            workAreas.contains { area in
                let w = Swift.min(r.maxX, area.maxX) - Swift.max(r.minX, area.minX)
                let h = Swift.min(r.maxY, area.maxY) - Swift.max(r.minY, area.minY)
                return w >= 200 && h >= 120
            }
        }
        func sized(_ r: CGRect) -> CGSize { CGSize(width: Swift.max(min.width, r.width), height: Swift.max(min.height, r.height)) }
        func at(_ r: CGRect) -> Placed {
            let s = sized(r)
            let out = CGRect(origin: r.origin, size: s)
            return onScreen(out) ? Placed(origin: r.origin, size: s) : Placed(origin: nil, size: s)
        }
        if let bounds { return at(bounds) }
        if let from { return at(from.offsetBy(dx: 24, dy: 24)) }
        return Placed(origin: nil, size: size)
    }

    /// The window's edges the resize strips hold (WindowEdges.jsx). The top edge is the title bar's.
    public enum Edge: String, CaseIterable, Sendable { case left, right, bottom, bottomLeft = "bottom-left", bottomRight = "bottom-right" }

    /// The window's bounds (y-down) after the pointer moved (dx, dy) from where the press began: the side opposite the held
    /// one stays put, never below the minimum size.
    public static func resizedBounds(_ start: CGRect, edge: Edge, dx: CGFloat, dy: CGFloat, min: CGSize = .zero) -> CGRect {
        var x = start.minX, y = start.minY, width = start.width, height = start.height
        if edge == .right || edge == .bottomRight { width = Swift.max(min.width, start.width + dx) }
        if edge == .left || edge == .bottomLeft {
            width = Swift.max(min.width, start.width - dx)
            x = start.minX + start.width - width
        }
        if edge == .bottom || edge == .bottomLeft || edge == .bottomRight { height = Swift.max(min.height, start.height + dy) }
        y = start.minY
        return CGRect(x: x.rounded(), y: y.rounded(), width: width.rounded(), height: height.rounded())
    }

    /// AppKit (y-up, origin at the main display's bottom) ↔ y-down screen rects, about the main display's height.
    public static func yDown(_ r: CGRect, mainHeight: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: mainHeight - r.maxY, width: r.width, height: r.height)
    }
    public static func yUp(_ r: CGRect, mainHeight: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: mainHeight - r.maxY, width: r.width, height: r.height)
    }
}

/// `parseExternalUrl`: only http(s), at most 4096 characters.
public enum ExternalURL {
    public enum Failure: Error, Equatable { case notBounded, invalid, scheme }
    public static func parse(_ value: String) throws -> URL {
        guard !value.isEmpty, value.count <= 4096 else { throw Failure.notBounded }
        guard let url = URL(string: value), let scheme = url.scheme?.lowercased(), url.host != nil else { throw Failure.invalid }
        guard scheme == "http" || scheme == "https" else { throw Failure.scheme }
        return url
    }
}
