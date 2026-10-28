import AppKit
import Foundation

// Small pieces of src/main/index.cjs and window-lifecycle.cjs that belong with the terminal and that the app calls.

public enum WindowLifecycle {
    /// On macOS the last window hides rather than closes (its terminal stays attached, its tabs stay open) until Quit.
    public static func shouldHideWindowOnClose(platformIsMac: Bool = true, quitReady: Bool) -> Bool { platformIsMac && !quitReady }
}

/// The question quitting asks while terminal sessions run (index.cjs requestQuit). Restart to Update has said already
/// that sessions end, so it skips this.
public enum TerminalQuit {
    public static func message(running: Int) -> String {
        "Quit and end \(running) running terminal session\(running == 1 ? "" : "s")?"
    }

    public static let detail = "Terminal sessions live in this app process and cannot be recovered after quitting. Documents are already saved."

    /// → whether to go on quitting. No running sessions: true without asking.
    @MainActor
    public static func confirm(running: Int, window: NSWindow?) -> Bool {
        guard running > 0 else { return true }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = message(running: running)
        alert.informativeText = detail
        alert.addButton(withTitle: "Quit and End Sessions")
        let cancel = alert.addButton(withTitle: "Cancel")
        cancel.keyEquivalent = "\r" // defaultId: Cancel
        alert.buttons.first?.keyEquivalent = ""
        if let window, !window.isVisible { window.makeKeyAndOrderFront(nil) }
        return alert.runModal() == .alertFirstButtonReturn
    }
}

/// The folder picker behind the cwd chip and the create screen's Code directory (index.cjs terminal:pick-directory).
public enum DirectoryPicker {
    /// Where the panel opens: `current` when it is a directory, else the home directory — never Engelbart's own data
    /// folder, where the last terminal may have been.
    public static func startDirectory(current: String?, home: String = TerminalPaths.home) -> String {
        if let current, current.utf16.count <= 4096 {
            var dir: ObjCBool = false
            if FileManager.default.fileExists(atPath: current, isDirectory: &dir), dir.boolValue { return current }
        }
        return home
    }

    /// The chosen folder, or nil. ENGELBART_PICK_DIRECTORY answers at once (driver harness only).
    @MainActor
    public static func pick(current: String?, window: NSWindow?, completion: @escaping (String?) -> Void) {
        if let forced = ProcessInfo.processInfo.environment["ENGELBART_PICK_DIRECTORY"], !forced.isEmpty { completion(forced); return }
        let panel = NSOpenPanel()
        panel.title = "Choose working directory"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: startDirectory(current: current), isDirectory: true)
        let done: (NSApplication.ModalResponse) -> Void = { response in
            completion(response == .OK ? panel.urls.first?.path : nil)
        }
        if let window { panel.beginSheetModal(for: window, completionHandler: done) } else { done(panel.runModal()) }
    }
}
