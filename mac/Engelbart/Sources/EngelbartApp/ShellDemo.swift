import EngelbartCore
import Foundation

/// The wave-1 demo settings for scripted runs (DemoBackend.swift): `ENGELBART_SHELL_DEMO` and `ENGELBART_SHELL_SETTINGS`,
/// from the process environment or, since the cloud runner sets only ENGELBART_DRIVE, from the drive script's
/// `"env": { "ENGELBART_SHELL_DEMO": "workspace" }`. Only these two keys are read from a script.
public enum ShellDemo {
    public static let keys = ["ENGELBART_SHELL_DEMO", "ENGELBART_SHELL_SETTINGS"]

    public static func environment(_ process: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var env = process
        if let path = process["ENGELBART_DRIVE"], !path.isEmpty, let script = Files.readJSON(URL(fileURLWithPath: path)),
           let extra = script["env"]?.object {
            for key in keys where env[key] == nil { if let value = extra[key]?.string { env[key] = value } }
        }
        return env
    }

    public static let current: [String: String] = environment()
    public static var mode: String? { current["ENGELBART_SHELL_DEMO"] }
    public static var settingsPage: String? { current["ENGELBART_SHELL_SETTINGS"] }
}
