import Foundation

/// The environment child processes get. An app opened from Finder or the Dock inherits launchd's short PATH
/// (/usr/bin:/bin:/usr/sbin:/sbin), so `claude`, `codex`, `node`, Homebrew git… are not found. The Electron app solved
/// this by reading the login shell's PATH; this does the same once per launch and caches it.
public enum ShellEnvironment {
    private static let lock = NSLock()
    private static var cachedPath: String?

    /// Extra directories always searched after the login shell's PATH (where the installers put the CLIs).
    public static var fallbackDirectories: [String] {
        let home = NSHomeDirectory()
        return ["\(home)/.local/bin", "\(home)/.claude/local", "/opt/homebrew/bin", "/usr/local/bin", "\(home)/.npm-global/bin",
                "\(home)/.bun/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    }

    /// The login shell's PATH (`$SHELL -ilc` prints it between markers so rc-file noise is ignored), merged with the
    /// fallback directories. Computed once; `refresh()` reads it again (after a tool install).
    public static func path() -> String {
        lock.lock()
        if let cachedPath { lock.unlock(); return cachedPath }
        lock.unlock()
        let computed = readLoginPath()
        lock.lock(); cachedPath = computed; lock.unlock()
        return computed
    }

    public static func refresh() {
        lock.lock(); cachedPath = nil; lock.unlock()
        _ = path()
    }

    /// The process environment with the login PATH, plus `extra` on top.
    public static func environment(_ extra: [String: String] = [:]) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path()
        if env["HOME"] == nil { env["HOME"] = NSHomeDirectory() }
        if env["LANG"] == nil { env["LANG"] = "en_US.UTF-8" }
        for (k, v) in extra { env[k] = v }
        return env
    }

    /// Resolves a command name the way a shell would (absolute or relative paths are taken as given).
    public static func resolve(_ name: String, environment: [String: String]? = nil) -> URL? {
        if name.contains("/") {
            return FileManager.default.isExecutableFile(atPath: name) ? URL(fileURLWithPath: name) : nil
        }
        let searchPath = environment?["PATH"] ?? path()
        for dir in searchPath.split(separator: ":") {
            let candidate = "\(dir)/\(name)"
            if FileManager.default.isExecutableFile(atPath: candidate) { return URL(fileURLWithPath: candidate) }
        }
        return nil
    }

    private static func readLoginPath() -> String {
        let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        let marker = "__ENGELBART_PATH__"
        var found: String?
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = ["-ilc", "printf '\(marker)%s\(marker)' \"$PATH\""]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do {
            try p.run()
            let deadline = Date().addingTimeInterval(5)
            while p.isRunning && Date() < deadline { usleep(20_000) }
            if p.isRunning { p.terminate() }
            let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            if let start = text.range(of: marker), let end = text.range(of: marker, range: start.upperBound..<text.endIndex) {
                found = String(text[start.upperBound..<end.lowerBound])
            }
        } catch {}
        var parts: [String] = []
        for dir in (found ?? ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init) + fallbackDirectories
        where !dir.isEmpty && !parts.contains(dir) {
            parts.append(dir)
        }
        return parts.joined(separator: ":")
    }
}
