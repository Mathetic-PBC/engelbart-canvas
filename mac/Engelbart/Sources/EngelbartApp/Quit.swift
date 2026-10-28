import AppKit
import Foundation

/// Something that must stop before the app quits (index.cjs requestQuit's list): the sweeper, Bart, Connect, Builds, the
/// sandboxes, every window's views, tool sign-ins, the terminal manager, the store. Registered in that order by wave 2.
public protocol QuitParticipant: AnyObject {
    var name: String { get }
    /// Running terminal sessions (only the terminal manager has any): quitting ends them, so the quit asks first.
    func runningSessions() -> Int
    /// Stops; a throw cancels the quit with "Unable to shut down cleanly".
    func shutdown() async throws
    /// A failure that is only logged (the sandboxes: one that cannot be reached never holds the quit).
    var failureIsFatal: Bool { get }
}

public extension QuitParticipant {
    func runningSessions() -> Int { 0 }
    var failureIsFatal: Bool { true }
}

/// The quit confirmation's words (index.cjs:237-246).
public enum QuitPrompt {
    public static let title = "Quit Engelbart?"
    public static func message(_ count: Int) -> String { "Quit and end \(count) running terminal session\(count == 1 ? "" : "s")?" }
    public static let detail = "Terminal sessions live in this app process and cannot be recovered after quitting. Documents are already saved."
    public static let buttons = ["Quit and End Sessions", "Cancel"]
}

/// requestQuit (index.cjs:228-286). Every quit path comes here: ⌘Q, the Dock's Quit, logging out, an update's restart.
@MainActor
public final class QuitController {
    public private(set) var pending = false
    public private(set) var ready = false
    private var relaunchWanted = false
    private var participants: [QuitParticipant] = []

    /// Saves every window as it is now, before any closes.
    public var saveWindowsNow: () -> Void = {}
    /// The window a dialog goes on, shown first when hidden.
    public var dialogWindow: () -> NSWindow? = { nil }
    /// Asks the question; true = quit. Replaced in tests.
    public var confirm: (_ count: Int, _ window: NSWindow?) async -> Bool = { count, window in await QuitController.ask(count, window) }
    /// Shows a failure. Replaced in tests.
    public var showError: (_ title: String, _ message: String) -> Void = { title, message in
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = message; alert.alertStyle = .critical; alert.runModal()
    }
    /// Ends the process (NSApp.reply(toApplicationShouldTerminate:) or terminate). Replaced in tests.
    public var finish: (_ relaunch: Bool) -> Void = { _ in }
    public var log: (String) -> Void = { FileHandle.standardError.write(Data("[engelbart] \($0)\n".utf8)) }

    public init() {}

    public func register(_ participant: QuitParticipant) { participants.append(participant) }

    public var runningSessions: Int { participants.reduce(0) { $0 + $1.runningSessions() } }

    /// `update`: Restart to Update, which has said already that terminal sessions end: no question. `relaunch`: Engelbart
    /// opens again once it has quit. → true once it goes on to quit; false when it does not (a quit under way, Cancel, a
    /// shutdown that failed).
    @discardableResult
    public func request(update: Bool = false, relaunch: Bool = false) async -> Bool {
        if pending || ready { if relaunch { relaunchWanted = true }; return false }
        pending = true
        let count = update ? 0 : runningSessions
        if count > 0 {
            let window = dialogWindow()
            if let window, !window.isVisible { window.makeKeyAndOrderFront(nil) }
            guard await confirm(count, window) else { pending = false; return false }
        }
        saveWindowsNow()
        for participant in participants {
            do {
                try await participant.shutdown()
            } catch {
                if participant.failureIsFatal {
                    pending = false
                    showError("Unable to shut down cleanly", error.localizedDescription)
                    return false
                }
                log("\(participant.name) shutdown: \(error.localizedDescription)")
            }
        }
        ready = true
        finish(relaunch || relaunchWanted)
        return true
    }

    static func ask(_ count: Int, _ window: NSWindow?) async -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = QuitPrompt.message(count)
        alert.informativeText = QuitPrompt.detail
        for title in QuitPrompt.buttons { alert.addButton(withTitle: title) }
        // Cancel is the default (Return) and the cancel (Escape) button.
        alert.buttons[0].keyEquivalent = ""
        alert.buttons[1].keyEquivalent = "\r"
        alert.window.title = QuitPrompt.title
        if let window {
            return await withCheckedContinuation { c in
                alert.beginSheetModal(for: window) { c.resume(returning: $0 == .alertFirstButtonReturn) }
            }
        }
        return alert.runModal() == .alertFirstButtonReturn
    }

    /// Opens the app again after it quits (app.relaunch()): `open -n` on the bundle once this process is gone.
    public static func relaunch() {
        let path = Bundle.main.bundleURL.pathExtension == "app" ? Bundle.main.bundlePath : (Bundle.main.executablePath ?? CommandLine.arguments[0])
        let pid = ProcessInfo.processInfo.processIdentifier
        let script = "while kill -0 \(pid) 2>/dev/null; do sleep 0.1; done; " +
            (path.hasSuffix(".app") ? "/usr/bin/open -n \"\(path)\"" : "\"\(path)\" >/dev/null 2>&1 &")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script]
        try? p.run()
    }
}
