import AppKit
import SwiftUI
import EngelbartUI

/// The post-its' own colours (face.css, card.css, TrashPanel.jsx, the popups): the yellow and its browns are nowhere else
/// in the app, so they live here; the greys and ink are the UI tokens.
public enum PostItLook {
    public static let face = NSColor(hex: "#fff2a0")
    /// Over the trash: a warmer shade, so letting go is visibly going to throw it away.
    public static let faceOverTrash = NSColor(hex: "#ffd08a")
    public static let word = NSColor(hex: "#705717")
    public static let placeholder = NSColor(hex: "#8a752d")
    public static let focus = NSColor(hex: "#a08f52")
    public static let saveError = NSColor(hex: "#b42318")
    public static let swatchBorder = NSColor(hex: "#e8d77a")
    public static let ink = Palette.ink
    public static let blue = Palette.acc

    // The card's glyphs (Card.jsx), from their own SVG paths.
    static let note = Icon("note", grid: 16, stroke: 1.4, size: 13, [IconShape(.path("M4.5 1.5h4.5L12 4.5v9a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z M9 1.5v3h3 M5.75 8h4.5 M5.75 10.5h4.5"))])
    static let build = Icon("build", grid: 24, stroke: 1.6, size: 13, [IconShape(.circle(cx: 12, cy: 12, r: 10.5)), IconShape(.path("M12 17.5V6.5 M7.2 11.3 12 6.5l4.8 4.8"))])
    static let workspace = Icon("workspace", grid: 16, stroke: 1.4, roundCaps: false, size: 13, [IconShape(.path("M2.5 1.5h2.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1z M9 1.5h4.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-4.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1z M2.5 8h4.5a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-4.5a1 1 0 0 1-1-1v-4.5a1 1 0 0 1 1-1z M11 8h2.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1z"))])
    static let copy = Icon("copy", grid: 14, stroke: 1.2, roundCaps: false, roundJoins: false, size: 14, [
        IconShape(.rect(x: 4.5, y: 4.5, width: 7.5, height: 7.5, rx: 1.5)),
        IconShape(.path("M9.5 2.5V2.2c0-.7-.5-1.2-1.2-1.2H3.2C2.5 1 2 1.5 2 2.2v5.1c0 .7.5 1.2 1.2 1.2h.3")),
    ])
    static let check = Icon("check", grid: 14, stroke: 1.5, size: 14, [IconShape(.path("M3 7.5 6 10.5 11.5 4"))])
    static let resize = Icon("resize", grid: 12, stroke: 1.2, roundCaps: false, roundJoins: false, size: 12, [IconShape(.path("M3 10 10 3M7 10l3-3"))])
    /// TrashPanel.jsx's project glyph (14 px, #4d4d4d, 1.3).
    static let trashedProject = Icon("project", grid: 16, stroke: 1.3, roundCaps: false, size: 14, workspace.shapes)
    /// PostItTask.jsx's (14 px, ink, 1.4).
    static let taskWorkspace = Icon("workspace", grid: 16, stroke: 1.4, roundCaps: false, size: 14, workspace.shapes)
    /// PostItBuild.jsx's ⊕ (16 px, 1.3) and folder (16 px, 1.3), and the search glyphs (2.6 on 24).
    static let circlePlus = Icon("context", grid: 18, stroke: 1.3, size: 16, [IconShape(.circle(cx: 9, cy: 9, r: 7.5)), IconShape(.path("M9 5.5v7 M5.5 9h7"))])
    static let folder = Icon("folder", grid: 16, stroke: 1.3, roundCaps: false, size: 16, [IconShape(.path("M1.5 4a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"))])
    static let search = Icon("search", grid: 24, stroke: 2.6, size: 16, [IconShape(.circle(cx: 10, cy: 10, r: 6.5)), IconShape(.line(x1: 15, y1: 15, x2: 21, y2: 21))])
    /// KIND.git's glyph (the GitHub mark) at 13 px.
    static let git = KindIcons.gh

    static func sans(_ size: CGFloat, _ weight: Int = 400) -> NSFont { Fonts.sans(size, weight: weight) }
    static func font(_ size: CGFloat, _ weight: Int = 400) -> Font { Font(Fonts.sans(size, weight: weight)) }
    static let ease = Animation.timingCurve(0.25, 0.1, 0.25, 1, duration: 0.16)
}

extension Color {
    static let pInk = Color(Palette.ink)
    static let pMut = Color(Palette.mut)
    static let pFnt = Color(Palette.fnt)
    static let pBd = Color(Palette.bd)
    static let pBd2 = Color(Palette.bd2)
    static let pHov = Color(Palette.hov)
    static let pTint = Color(Palette.tint)
    static let pRed = Color(Palette.del)
    static let pBlue = Color(Palette.acc)
}

/// A self-test marker on an AppKit view (EngelbartUI `.driveID`, mac/Engelbart/API.md): a SwiftUI marker filling the
/// view that never takes a press, named after the Electron data-* attribute the view stands for.
final class DriveTag: NSView {
    private let host: NSHostingView<AnyView>
    private(set) var id: String
    init(_ id: String) {
        self.id = id
        host = NSHostingView(rootView: AnyView(Color.clear.driveID(id)))
        super.init(frame: .zero)
        host.autoresizingMask = [.width, .height]
        addSubview(host)
        autoresizingMask = [.width, .height]
    }
    required init?(coder: NSCoder) { fatalError() }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    func rename(_ next: String) {
        guard next != id else { return }
        id = next
        host.rootView = AnyView(Color.clear.driveID(next))
    }
    /// Puts (or renames) the marker on `view`, filling it.
    @discardableResult
    static func mark(_ view: NSView, _ id: String) -> DriveTag {
        if let tag = view.subviews.compactMap({ $0 as? DriveTag }).first { tag.rename(id); return tag }
        let tag = DriveTag(id)
        tag.frame = view.bounds
        view.addSubview(tag, positioned: .below, relativeTo: nil)
        return tag
    }
}
