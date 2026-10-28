import Foundation

/// Where the terminal keeps its own files. Electron used `app.getPath('userData')`; the Swift app's app-private folder is
/// `~/Library/Application Support/Engelbart Swift/` (ARCHITECTURE §3). The launcher, the zsh wrappers, bash's init file
/// and `settings.json` live under it, as they did under Electron's userData. The path has a space in it: everything that
/// writes it into a script quotes it (ShellRC.swift).
public enum TerminalPaths {
    public static var userData: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Engelbart Swift", isDirectory: true)
    }

    /// `app.getPath('home')`, honouring ENGELBART_HOME_DIR as the Electron app does.
    public static var home: String {
        if let override = ProcessInfo.processInfo.environment["ENGELBART_HOME_DIR"], !override.isEmpty { return override }
        return NSHomeDirectory()
    }
}
