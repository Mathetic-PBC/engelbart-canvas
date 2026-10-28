import Foundation

/// Where the app keeps things (ARCHITECTURE §3). The data root is `~/.engelbart-swift` (never `~/.engelbart`, Hudson's
/// real planning data used by the Electron app), `ENGELBART_ROOT_DIR` overrides it, `ENGELBART_HOME_DIR` the home (as in
/// Electron, index.cjs:621). What Electron kept in `userData` goes to `~/Library/Application Support/Engelbart Swift`;
/// `ENGELBART_USER_DATA_DIR` overrides that for scripted runs (a Swift addition: Electron's runs passed
/// `--user-data-dir`), which also keys the single-instance lock, so a scripted copy never collides with a running one.
public struct AppPaths: Sendable {
    public var home: URL
    public var dataRoot: URL
    public var userData: URL

    public init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        let home = environment["ENGELBART_HOME_DIR"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: NSHomeDirectory())
        self.home = home
        if let root = environment["ENGELBART_ROOT_DIR"], !root.isEmpty {
            dataRoot = URL(fileURLWithPath: (root as NSString).expandingTildeInPath)
        } else {
            dataRoot = home.appendingPathComponent(".engelbart-swift")
        }
        if let dir = environment["ENGELBART_USER_DATA_DIR"], !dir.isEmpty {
            userData = URL(fileURLWithPath: (dir as NSString).expandingTildeInPath)
        } else {
            userData = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/Engelbart Swift")
        }
    }

    /// Test mode's root inside the data root.
    public var testRoot: URL { dataRoot.appendingPathComponent("test") }

    /// A path as the person reads it: the home folder as `~`.
    public static func shown(_ url: URL, home: String = NSHomeDirectory()) -> String {
        let path = url.standardizedFileURL.path
        if path == home { return "~" }
        if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
        return path
    }

    /// The folder must never be Electron's `~/.engelbart` (or inside it): the Swift app writes nothing there.
    public static func isElectronRoot(_ url: URL, home: URL) -> Bool {
        let electron = home.appendingPathComponent(".engelbart").standardizedFileURL.path
        let path = url.standardizedFileURL.path
        return path == electron || path.hasPrefix(electron + "/")
    }
}
