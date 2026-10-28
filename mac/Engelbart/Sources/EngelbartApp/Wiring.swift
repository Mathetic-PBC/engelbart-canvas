import AppKit
import EngelbartUI

/// Where wave 2 wires the feature packages into the shell: fill `slots` (screens, backend, window places, tools gate…),
/// register MCP servers in `MCPServers.registerAll()` and quit participants on `delegate.quit`. Called first thing in
/// `applicationWillFinishLaunching`, before the menu is built and any window opens. Empty in wave 1.
@MainActor
public enum EngelbartWiring {
    public static func install(_ slots: ScreenSlots, delegate: AppDelegate) {
        // WAVE 2: e.g. slots.backend = { StoreShellBackend(store) }; slots.windowPlaces = StoreWindowPlaces(store)
    }

    /// The Store (or anything else needed before the first window) failed to open: "Engelbart failed to start", exit 1
    /// (index.cjs:1403-1406).
    public static func failedToStart(_ error: Error) -> Never {
        Dialogs.errorBox("Engelbart failed to start", error.localizedDescription)
        exit(1)
    }
}
