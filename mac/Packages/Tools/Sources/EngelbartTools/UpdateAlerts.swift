import AppKit

/// The updater's message boxes as Electron's dialog.showMessageBox drew them: a sheet on the focused window when there is
/// one (`getWindow`), else an app-modal alert; `noLink` buttons in order, `defaultId` is Return, `cancelId` is Escape.
/// → the index of the button pressed. Pass `UpdateAlerts.ask` as `Updates(ask:)`.
@MainActor
public enum UpdateAlerts {
    public static func ask(_ dialog: UpdateDialog) async -> Int {
        let alert = NSAlert()
        alert.alertStyle = dialog.type == "warning" ? .warning : .informational
        alert.messageText = dialog.message
        alert.informativeText = dialog.detail ?? ""
        for (index, title) in dialog.buttons.enumerated() {
            let button = alert.addButton(withTitle: title)
            button.keyEquivalent = index == (dialog.defaultId ?? 0) ? "\r" : index == dialog.cancelId ? "\u{1b}" : ""
        }
        let first = NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        if let window = NSApp.keyWindow ?? NSApp.mainWindow {
            return await withCheckedContinuation { continuation in
                alert.beginSheetModal(for: window) { response in continuation.resume(returning: response.rawValue - first) }
            }
        }
        return alert.runModal().rawValue - first
    }
}
