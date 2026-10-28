import AppKit
import SwiftUI
import EngelbartUI

// The look of Import your context and its popups: the onboarding mockup's CSS scoped under `.ix`
// (src/renderer/import/import-css.js, round3-css.js, round4-css.js), 1 CSS px = 1 pt. Round 3 made every selection black
// (`--chosen`) and greyed the old blue (`--blue: #737373`), keeping blue for the picker's ticked circles; round 4 drew
// the selected rows at 1.5 (a 1px border plus an inset half point). No horizontal divider lines anywhere.

public enum IX {
    public static let ink = Color(NSColor(hex: "#171717"))
    public static let mute = Color(NSColor(hex: "#8f8f8f"))
    public static let body = Color(NSColor(hex: "#4d4d4d"))
    public static let line = Color(NSColor(hex: "#eaeaea"))
    public static let line2 = Color(NSColor(hex: "#c9c9c9"))
    /// The modal's paragraph grey (.modal p).
    public static let para = Color(NSColor(hex: "#6b6b6b"))
    public static let blue = Color(NSColor(hex: "#0070f3"))
    /// round3's `--blue`: the activity dot and the review chips.
    public static let grey = Color(NSColor(hex: "#737373"))
    public static let red = Color(NSColor(hex: "#e70022"))
    public static let amber = Color(NSColor(hex: "#a35200"))
    public static let wash = Color(NSColor(hex: "#fafafa"))
    public static let hover = Color(NSColor(hex: "#f1f1f1"))
    public static let font = { (size: CGFloat, weight: Int) in Fonts.swiftUISans(size, weight: weight) }
    /// The scrim behind a dialog (.scrim #00000040) and the popups' own veils.
    public static let scrim = Color.black.opacity(0x40 / 255)
    public static let veil = Color(NSColor(srgbRed: 23 / 255, green: 23 / 255, blue: 23 / 255, alpha: 0.18))
    public static let veilDark = Color(NSColor(srgbRed: 23 / 255, green: 23 / 255, blue: 23 / 255, alpha: 0.28))
}

/// .btn (44 tall, radius 10, ink, 15/500), .btn.small (38, 14), .btn.secondary (white, #c9c9c9), .link (#8f8f8f 14,
/// ink on hover), .link.under (underlined, ink).
public struct IXButton: View {
    public enum Kind { case primary, secondary, link, under }
    let title: String
    let kind: Kind
    let small: Bool
    let size: CGFloat?
    let disabled: Bool
    let chevron: Bool
    let id: String?
    let width: CGFloat?
    let action: () -> Void
    @State private var hovering = false
    public init(_ title: String, _ kind: Kind = .primary, small: Bool = false, size: CGFloat? = nil, disabled: Bool = false, chevron: Bool = false, width: CGFloat? = nil,
                id: String? = nil, action: @escaping () -> Void) {
        self.title = title; self.kind = kind; self.small = small; self.size = size; self.disabled = disabled; self.chevron = chevron; self.width = width; self.id = id; self.action = action
    }
    public var body: some View {
        let label = HStack(spacing: 8) {
            Text(title)
            if chevron { SVGShape(markup: #"<path d="m9 5 7 7-7 7"/>"#).stroke(style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round)).frame(width: 17, height: 17) }
        }
        let button = Button(action: { if !disabled { action() } }) {
            switch kind {
            case .primary, .secondary:
                label.font(IX.font(size ?? (small ? 14 : 15), 500)).lineLimit(1)
                    .padding(.horizontal, 20).frame(width: width).frame(minHeight: small ? 38 : 44)
                    .foregroundStyle(kind == .primary ? Color.white : IX.ink)
                    .background(RoundedRectangle(cornerRadius: 10).fill(kind == .primary ? IX.ink : Color.white))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(kind == .primary ? IX.ink : IX.line2, lineWidth: 1))
                    .brightness(hovering && !disabled ? -0.06 : 0)
            case .link:
                label.font(IX.font(size ?? 14, 400)).foregroundStyle(hovering && !disabled ? IX.ink : IX.mute)
            case .under:
                label.font(IX.font(size ?? 14, 400)).underline().foregroundStyle(IX.ink)
            }
        }
        .buttonStyle(.plain)
        .opacity(disabled ? 0.4 : 1)
        .onHover { hovering = $0 }
        .contentShape(Rectangle())
        if let id { button.driveID(id) } else { button }
    }
}

/// The checks: .cb (17, radius 4, 1.5 #c9c9c9; on: filled, a white ✓). The picker's and the projects' are circles,
/// blue when ticked (round 3).
public struct IXCheck: View {
    let on: Bool
    let circle: Bool
    let size: CGFloat
    public init(on: Bool, circle: Bool = true, size: CGFloat = 17) { self.on = on; self.circle = circle; self.size = size }
    public var body: some View {
        ZStack {
            if circle {
                Circle().fill(on ? IX.blue : Color.white)
                Circle().strokeBorder(on ? IX.blue : IX.line2, lineWidth: 1.5)
            } else {
                RoundedRectangle(cornerRadius: 4).fill(on ? IX.blue : Color.white)
                RoundedRectangle(cornerRadius: 4).strokeBorder(on ? IX.blue : IX.line2, lineWidth: 1.5)
            }
            if on { CheckMark().stroke(Color.white, style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round)).frame(width: 11, height: 11) }
        }
        .frame(width: size, height: size)
    }
}

/// The ✓ of the mockup (m5 12 4 4 10-10 on a 24 grid).
public struct CheckMark: Shape {
    public init() {}
    public func path(in rect: CGRect) -> Path { SVGShape(markup: #"<path d="m5 12 4 4 10-10"/>"#).path(in: rect) }
}

/// An icon drawn from the renderer's SVG markup on a 24 × 24 grid: `<path d>`, `<rect>`, `<circle>` (the roles' icons,
/// the chevrons, the folder and globe glyphs).
public struct SVGShape: Shape {
    let markup: String
    let grid: CGFloat
    public init(markup: String, grid: CGFloat = 24) { self.markup = markup; self.grid = grid }

    public static func cgPath(_ markup: String) -> CGPath {
        let out = CGMutablePath()
        func attr(_ element: String, _ name: String) -> CGFloat {
            guard let r = element.range(of: #"\b\#(name)="([^"]*)""#, options: .regularExpression) else { return 0 }
            let raw = element[r].split(separator: "\"").dropFirst().first.map(String.init) ?? "0"
            return CGFloat(Double(raw) ?? 0)
        }
        let regex = try! NSRegularExpression(pattern: #"<(path|rect|circle)\b[^>]*>"#)
        let ns = markup as NSString
        for match in regex.matches(in: markup, range: NSRange(location: 0, length: ns.length)) {
            let element = ns.substring(with: match.range)
            let kind = ns.substring(with: match.range(at: 1))
            switch kind {
            case "path":
                if let r = element.range(of: #"\bd="([^"]*)""#, options: .regularExpression) {
                    let d = String(element[r].dropFirst(3).dropLast())
                    out.addPath(SVGPath.parse(d))
                }
            case "rect":
                let rect = CGRect(x: attr(element, "x"), y: attr(element, "y"), width: attr(element, "width"), height: attr(element, "height"))
                let rx = min(attr(element, "rx"), rect.width / 2, rect.height / 2)
                out.addRoundedRect(in: rect, cornerWidth: rx, cornerHeight: rx)
            default:
                let r = attr(element, "r")
                out.addEllipse(in: CGRect(x: attr(element, "cx") - r, y: attr(element, "cy") - r, width: r * 2, height: r * 2))
            }
        }
        return out
    }

    public func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / grid
        var t = CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: scale, y: scale)
        guard let scaled = Self.cgPath(markup).copy(using: &t) else { return Path() }
        return Path(scaled)
    }
}

/// The glyphs ImportFlow.jsx draws.
public enum IXGlyph {
    public static let chevron = #"<path d="m9 5 7 7-7 7"/>"#
    public static let down = #"<path d="m6 9 6 6 6-6"/>"#
    public static let check = #"<path d="m5 12 4 4 10-10"/>"#
    public static let folder = #"<path d="M2 5h7l2 2h11v13H2z"/>"#
    public static let file = #"<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5"/>"#
    public static let globe = #"<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 0 0 18 17 17 0 0 0 0-18"/>"#
    public static let web = #"<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/>"#
    public static let plus = #"<path d="M12 5v14M5 12h14"/>"#
    public static let search = #"<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>"#
    /// How should Engelbart import your sources? (S8): the sidebar's Agents pointer, and a raised hand (Lucide's, ISC).
    public static let agent = "<path d=\"\(SidebarIcons.agentsPath)\"/>"
    public static let hand = #"<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>"#
}

/// An SVG glyph stroked like `.ix svg` (1.6, round caps), `size` square.
public struct Glyph: View {
    let markup: String
    let size: CGFloat
    let width: CGFloat
    public init(_ markup: String, size: CGFloat = 17, width: CGFloat = 1.6) { self.markup = markup; self.size = size; self.width = width }
    public var body: some View {
        SVGShape(markup: markup).stroke(style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)).frame(width: size, height: size)
    }
}

/// A logo of Resources/logos, or the folder glyph when there is none.
public struct LogoImage: View {
    let file: String?
    let size: CGFloat
    public init(file: String?, size: CGFloat = 17) { self.file = file; self.size = size }
    public var body: some View {
        if let file, let image = Logos.image(file: file) {
            Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit).frame(width: size, height: size)
        } else {
            Glyph(IXGlyph.folder, size: size)
        }
    }
}

/// The white card a dialog sits in (.modal): radius 14, padding 26, the mockup's shadow.
public struct IXModal<Content: View>: View {
    let width: CGFloat
    let padding: CGFloat
    let content: Content
    public init(width: CGFloat = 486, padding: CGFloat = 26, @ViewBuilder content: () -> Content) { self.width = width; self.padding = padding; self.content = content() }
    public var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(padding)
            .frame(width: width, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.white))
            .shadow(color: Color.black.opacity(0x26 / 255), radius: 30, x: 0, y: 20)
    }
}

/// The dialog's title (.modal h3: 20/1.3 600, −.4) and paragraph (15/1.55 #6b6b6b, 16 above).
public struct IXTitle: View {
    let text: String
    public init(_ text: String) { self.text = text }
    public var body: some View { Text(text).font(IX.font(20, 600)).tracking(-0.4).foregroundStyle(IX.ink).lineSpacing(6 * 0.3).fixedSize(horizontal: false, vertical: true) }
}
public struct IXPara: View {
    let text: String
    public init(_ text: String) { self.text = text }
    public var body: some View { Text(text).font(IX.font(15, 400)).foregroundStyle(IX.para).lineSpacing(15 * 0.55 - 4).fixedSize(horizontal: false, vertical: true).padding(.top, 16) }
}
/// The dialog's foot (.mf): right-aligned, gap 20, 22 above.
public struct IXFoot<Content: View>: View {
    let content: Content
    let gap: CGFloat
    public init(gap: CGFloat = 20, @ViewBuilder content: () -> Content) { self.gap = gap; self.content = content() }
    public var body: some View { HStack(spacing: gap) { Spacer(minLength: 0); content }.padding(.top, 22) }
}

/// A full-window scrim with its dialog centred; a press on the scrim itself calls `onPress`.
public struct Scrim<Content: View>: View {
    let color: Color
    let onPress: () -> Void
    let content: Content
    public init(color: Color = IX.scrim, onPress: @escaping () -> Void = {}, @ViewBuilder content: () -> Content) { self.color = color; self.onPress = onPress; self.content = content() }
    public var body: some View {
        ZStack {
            color.contentShape(Rectangle()).onTapGesture { onPress() }.driveID("scrim")
            content.padding(20)
        }
    }
}

/// A text field drawn as .field: 1px #c9c9c9 (ink while focused), radius 8, 11/12 padding.
public struct IXField: View {
    let placeholder: String
    @Binding var text: String
    let id: String?
    let onSubmit: () -> Void
    @FocusState private var focused: Bool
    public init(_ placeholder: String, text: Binding<String>, id: String? = nil, onSubmit: @escaping () -> Void = {}) { self.placeholder = placeholder; self._text = text; self.id = id; self.onSubmit = onSubmit }
    public var body: some View {
        let field = TextField(placeholder, text: $text)
            .textFieldStyle(.plain).font(IX.font(15, 400)).foregroundStyle(IX.ink)
            .focused($focused).onSubmit(onSubmit)
            .padding(.horizontal, 12).padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.white))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? IX.ink : IX.line2, lineWidth: 1))
        if let id { field.driveID(id) } else { field }
    }
}

/// A growing text area (growReviewInput: 46 to 140 tall), Enter handled by `onEnter` (Shift+Enter a new line).
public struct GrowingField: View {
    let placeholder: String
    @Binding var text: String
    let size: CGFloat
    let onEnter: (() -> Void)?
    let id: String?
    @FocusState private var focused: Bool
    public init(_ placeholder: String, text: Binding<String>, size: CGFloat = 14, id: String? = nil, onEnter: (() -> Void)? = nil) {
        self.placeholder = placeholder; self._text = text; self.size = size; self.id = id; self.onEnter = onEnter
    }
    public var body: some View {
        let field = TextField(placeholder, text: $text, axis: .vertical)
            .textFieldStyle(.plain).font(IX.font(size, 400)).foregroundStyle(IX.ink).lineLimit(1...6)
            .focused($focused)
            .onKeyPress(.return, phases: .down) { press in
                guard let onEnter, !press.modifiers.contains(.shift) else { return .ignored }
                onEnter(); return .handled
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .frame(minHeight: 46, maxHeight: 140, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.white))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? IX.ink : IX.line2, lineWidth: 1))
        if let id { field.driveID(id) } else { field }
    }
}

/// A selected row's outline (round 4): black 1px plus an inset half point, so 1.5 in all.
struct Chosen: ViewModifier {
    let on: Bool
    let radius: CGFloat
    func body(content: Content) -> some View {
        content.overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(on ? IX.ink : IX.line, lineWidth: on ? 1.5 : 1))
    }
}
extension View {
    func chosen(_ on: Bool, radius: CGFloat = 10) -> some View { modifier(Chosen(on: on, radius: radius)) }
    /// The words that move while work goes on (the cx-shimmer / eb-wave), still words otherwise.
    @ViewBuilder func shimmer(_ on: Bool) -> some View { self }
}

/// "a, b and c".
func listOf(_ names: [String]) -> String { listed(names) }

/// A colour from "#rrggbb".
func hex(_ s: String) -> Color { Color(NSColor(hex: s)) }
