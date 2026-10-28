import EngelbartUI
import SwiftUI

// Where a screen's parts are, for tests that draw it offscreen. Every part named after its Electron `data-*` attribute
// carries that name as its accessibility identifier (the app's ENGELBART_DRIVE self-test finds it there); with a
// ProbeBook in the environment it also records its frame (the hosting view's coordinates, y down) and what pressing it
// does. Without a book it is only the identifier.

/// What the probed parts of a screen are: frames and presses, by identifier.
public final class ProbeBook: ObservableObject {
    public private(set) var frames: [String: CGRect] = [:]
    var presses: [String: () -> Void] = [:]
    public init() {}

    public func has(_ id: String) -> Bool { frames[id] != nil }
    public func frame(_ id: String) -> CGRect? { frames[id] }
    public func ids(prefix: String) -> [String] { frames.keys.filter { $0.hasPrefix(prefix) }.sorted() }
    /// Does what a click on it does; false when it is not there or does nothing.
    @discardableResult public func press(_ id: String) -> Bool {
        guard frames[id] != nil, let action = presses[id] else { return false }
        action()
        return true
    }

    /// How many views on screen carry each name (a part replaced by another of the same name appears before the old one
    /// is gone).
    private var shown: [String: Int] = [:]

    func appear(_ id: String, _ frame: CGRect, _ press: (() -> Void)?) {
        shown[id, default: 0] += 1
        record(id, frame, press)
    }
    func record(_ id: String, _ frame: CGRect, _ press: (() -> Void)?) {
        frames[id] = frame
        if let press { presses[id] = press } else { presses.removeValue(forKey: id) }
    }
    func forget(_ id: String) {
        let left = (shown[id] ?? 1) - 1
        shown[id] = max(0, left)
        if left <= 0 { frames.removeValue(forKey: id); presses.removeValue(forKey: id) }
    }
}

private struct ProbeBookKey: EnvironmentKey { static let defaultValue: ProbeBook? = nil }
public extension EnvironmentValues {
    var probeBook: ProbeBook? {
        get { self[ProbeBookKey.self] }
        set { self[ProbeBookKey.self] = newValue }
    }
}

struct ProbeModifier: ViewModifier {
    let id: String
    let press: (() -> Void)?
    @Environment(\.probeBook) private var book

    func body(content: Content) -> some View {
        if let book {
            content
                .driveID(id)
                .background(GeometryReader { g in
                    let frame = g.frame(in: .global)
                    // `.id(id)`: a part whose name changes (step=create → step=import) is a new one: the old name goes.
                    Color.clear
                        .onAppear { book.appear(id, frame, press) }
                        .onChange(of: frame) { _, now in book.record(id, now, press) }
                        .onDisappear { book.forget(id) }
                        .id(id)
                })
        } else {
            content.driveID(id)
        }
    }
}

extension View {
    /// The part's identifier (Electron's data-* name) and, under a ProbeBook, its frame and press.
    func probe(_ id: String, press: (() -> Void)? = nil) -> some View { modifier(ProbeModifier(id: id, press: press)) }
}
