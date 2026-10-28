import AppKit
import SwiftUI

/// Names a view for the self-test driver (`ENGELBART_DRIVE`, mac/Engelbart/API.md) and for accessibility. SwiftUI only
/// builds its accessibility tree for a connected accessibility client, which a CI runner has none of, so each named view
/// also leaves a marker NSView behind it in `DriveRegistry`: the driver finds it there, reads its frame and clicks it.
/// Name views after the Electron `data-*` attribute they stand for (`data-settings-page="model"` → `settings-page=model`).
public extension View {
    func driveID(_ id: String) -> some View {
        accessibilityIdentifier(id).background(DriveMarker(id: id))
    }
}

/// Every live marker by identifier, newest last.
@MainActor
public enum DriveRegistry {
    private static var markers: [(id: String, view: WeakView)] = []
    final class WeakView { weak var view: NSView?; init(_ v: NSView) { view = v } }

    static func add(_ id: String, _ view: NSView) {
        markers.removeAll { $0.view.view == nil || $0.view.view === view }
        markers.append((id, WeakView(view)))
    }

    static func remove(_ view: NSView) { markers.removeAll { $0.view.view == nil || $0.view.view === view } }

    /// The newest marker with this identifier that is on screen in one of `windows`.
    public static func view(_ id: String, in windows: [NSWindow]) -> NSView? {
        for entry in markers.reversed() where entry.id == id {
            guard let view = entry.view.view, let window = view.window, windows.contains(where: { $0 === window }),
                  window.isVisible, !view.isHiddenOrHasHiddenAncestor, view.bounds.width > 0 || view.bounds.height > 0 else { continue }
            return view
        }
        return nil
    }

    /// Every identifier on screen in `windows` (a failing step's report lists them).
    public static func ids(in windows: [NSWindow]) -> [String] {
        markers.compactMap { entry in
            guard let view = entry.view.view, let window = view.window, windows.contains(where: { $0 === window }) else { return nil }
            return entry.id
        }
    }
}

final class DriveMarkerView: NSView {
    var id = ""
    override func hitTest(_ point: NSPoint) -> NSView? { nil } // never takes a press
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        MainActor.assumeIsolated {
            if window != nil { DriveRegistry.add(id, self) } else { DriveRegistry.remove(self) }
        }
    }
}

struct DriveMarker: NSViewRepresentable {
    let id: String
    func makeNSView(context: Context) -> DriveMarkerView { let v = DriveMarkerView(); v.id = id; return v }
    func updateNSView(_ nsView: DriveMarkerView, context: Context) {
        if nsView.id != id { nsView.id = id; if nsView.window != nil { DriveRegistry.add(id, nsView) } }
    }
    static func dismantleNSView(_ nsView: DriveMarkerView, coordinator: ()) { DriveRegistry.remove(nsView) }
}
