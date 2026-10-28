import AppKit
import EngelbartCore
import Foundation
import UniformTypeIdentifiers

// The system dialogs and hand-offs index.cjs gave the renderer (terminal:pick-directory, pickPaths, confirmReset,
// openExternal, revealItem, writeClipboard, writeImage). Each honours the Electron driver variables, so scripted runs
// never wait on a panel.
@MainActor
public enum Dialogs {
    /// "Choose working directory": a folder (one may be made), starting at `current` when it is a folder, else the home
    /// folder (never Engelbart's own data folder). `ENGELBART_PICK_DIRECTORY` answers in scripted runs.
    public static func pickDirectory(current: String?, home: URL, window: NSWindow?, environment: [String: String] = ProcessInfo.processInfo.environment) async -> String? {
        if let fixed = environment["ENGELBART_PICK_DIRECTORY"] { return fixed }
        let panel = NSOpenPanel()
        panel.title = "Choose working directory"
        panel.message = "Choose working directory"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = startFolder(current, home: home)
        return await run(panel, window: window)?.first?.path
    }

    /// The folder a directory panel starts in.
    public static func startFolder(_ current: String?, home: URL) -> URL {
        if let current, current.count <= 4096, Files.isDirectory(URL(fileURLWithPath: current)) { return URL(fileURLWithPath: current) }
        return home
    }

    /// "Choose from disk…": files and folders together, several at once; `pdf`: papers only. `ENGELBART_PICK_PATHS` (a JSON
    /// array) answers in scripted runs.
    public static func pickPaths(pdfOnly: Bool, window: NSWindow?, environment: [String: String] = ProcessInfo.processInfo.environment) async -> [String] {
        if let fixed = environment["ENGELBART_PICK_PATHS"] {
            return ((try? JSONValue.parse(fixed))?.array ?? []).compactMap(\.string)
        }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseFiles = true
        panel.canChooseDirectories = !pdfOnly
        if pdfOnly { panel.allowedContentTypes = [.pdf]; panel.message = "Papers" }
        return (await run(panel, window: window) ?? []).map(\.path)
    }

    private static func run(_ panel: NSOpenPanel, window: NSWindow?) async -> [URL]? {
        if let window {
            return await withCheckedContinuation { c in
                panel.beginSheetModal(for: window) { c.resume(returning: $0 == .OK ? panel.urls : nil) }
            }
        }
        return panel.runModal() == .OK ? panel.urls : nil
    }

    /// The reset confirmation's words (index.cjs:1321-1338), naming this copy's test root.
    public struct ResetPrompt: Equatable {
        public var title: String, message: String, detail: String, confirm: String
        public static func make(fresh: Bool, testRootShown: String) -> ResetPrompt {
            ResetPrompt(
                title: fresh ? "Start as a new user?" : "Reset test data?",
                message: "Delete everything under \(testRootShown)?",
                detail: fresh
                    ? "Projects, notes, the test library, custom instructions and test mode's GitHub sign-in are removed, and onboarding starts. Your real data root is not touched."
                    : "Projects, notes, the test library and paper annotations are removed. The library is seeded again on the next start.",
                confirm: fresh ? "Start as a new user" : "Reset test data")
        }
    }

    /// Asks before test data is deleted; Cancel is the default. `ENGELBART_CONFIRM_ALL=1` says yes in scripted runs.
    public static func confirmReset(fresh: Bool, testRootShown: String, window: NSWindow?, environment: [String: String] = ProcessInfo.processInfo.environment) async -> Bool {
        if environment["ENGELBART_CONFIRM_ALL"] == "1" { return true }
        let prompt = ResetPrompt.make(fresh: fresh, testRootShown: testRootShown)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = prompt.message
        alert.informativeText = prompt.detail
        alert.addButton(withTitle: prompt.confirm)
        alert.addButton(withTitle: "Cancel")
        alert.buttons[0].keyEquivalent = ""
        alert.buttons[1].keyEquivalent = "\r"
        alert.window.title = prompt.title
        if let window {
            return await withCheckedContinuation { c in alert.beginSheetModal(for: window) { c.resume(returning: $0 == .alertFirstButtonReturn) } }
        }
        return alert.runModal() == .alertFirstButtonReturn
    }

    /// Opens an http(s) URL in the default browser; anything else is refused.
    @discardableResult
    public static func openExternal(_ value: String) throws -> Bool {
        let url = try ExternalURL.parse(value)
        return NSWorkspace.shared.open(url)
    }

    /// Finder, with the item selected (shell.showItemInFolder).
    public static func reveal(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    public static func writeClipboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    /// A picture to the clipboard as PNG (Electron 44's clipboard took it so). False when the bytes are not an image.
    @discardableResult
    public static func writeImage(_ data: Data) -> Bool {
        guard let image = NSImage(data: data), let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return false }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setData(png, forType: .png)
        return true
    }

    /// An error box (dialog.showErrorBox).
    public static func errorBox(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }
}
