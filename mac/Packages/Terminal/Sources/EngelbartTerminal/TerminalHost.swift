import AppKit

/// What the Workspace screen gives a Terminal pane (TerminalPane.jsx's props and the window events it used). Every member
/// but the project has a default, so a host implements only what it has.
///
/// App-wide wiring (the environment additions and the providers list from the Tools package, the process environment)
/// is `TerminalSessions.Configuration`, given once at launch; this is per pane.
@MainActor
public protocol TerminalHost: AnyObject {
    /// The project whose terminals this pane shows (TerminalPane `projectId`).
    var terminalProjectId: String? { get }
    /// The project's code directory (`project.json.directory`; TerminalPane `cwd`): where the first shell, `+` and ⌘T
    /// start. nil: no terminal starts ("no project directory").
    var terminalProjectDirectory: String? { get }
    /// A link clicked in a transcript, an http(s) address: open it as a tab on the Stage and show the Stage
    /// (OPEN_IN_BROWSER; spec #86).
    func terminalOpenLink(_ url: String)
    /// The folder picker behind the ▭ chip. Default: `DirectoryPicker.pick` (title "Choose working directory", starts in
    /// `current` when it exists, else home; ENGELBART_PICK_DIRECTORY for drivers).
    func terminalPickDirectory(current: String?, window: NSWindow?, completion: @escaping (String?) -> Void)
    /// Text pasted into a transcript, without a PDF's page layout (model/paste.js pdfText, MATH-24). Default: unchanged.
    func terminalPdfText(_ text: String) -> String
    /// Whether the middle canvas was clicked last and so has ⌘T (model/key-side.js, 2026-10-16). Default: false.
    func terminalKeysToDoc() -> Bool
    /// The right pane's full screen (the arrows at the end of the tab row). nil: no button.
    var terminalFullScreen: Bool? { get }
    func terminalToggleFullScreen()
    /// A sandbox's shell in front of a focused window is in use: put its sleep back 10 minutes (now and every minute).
    func terminalTouchSandbox(libraryId: String)
}

public extension TerminalHost {
    func terminalOpenLink(_ url: String) {}
    func terminalPickDirectory(current: String?, window: NSWindow?, completion: @escaping (String?) -> Void) {
        DirectoryPicker.pick(current: current, window: window, completion: completion)
    }
    func terminalPdfText(_ text: String) -> String { text }
    func terminalKeysToDoc() -> Bool { false }
    var terminalFullScreen: Bool? { nil }
    func terminalToggleFullScreen() {}
    func terminalTouchSandbox(libraryId: String) {}
}
