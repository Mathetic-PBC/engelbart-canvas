import Foundation

// Installing and updating what Engelbart needs (src/main/tools/install.cjs, 2026-09-23; design D9–D13). Started by the
// person (Install, Update); by the launch check for an update that brings a tool up to its minimum, when they allow it;
// and, on a Mac with neither agent, by the first launch for Claude Code (2026-09-28; Manager.swift decides which).
//
//   Git          Apple's Command Line Tools: `xcode-select --install` opens Apple's own dialog, which is the permission
//                request; then this waits for the tools to arrive, and notices when the installer is closed without
//                finishing. Only when the Git that comes with Engelbart (BundledGit.swift) is missing too.
//   Claude Code  https://claude.ai/install.sh      } each vendor's installer: SHA-256 checked, into the home folder, no
//   Codex        https://chatgpt.com/codex/install.sh } admin password. Downloaded to a file first, so a failed download
//                is not mistaken for a finished install.
//   Updates      `claude update` / `codex update`: each CLI knows whether it came from its installer, npm or Homebrew.
//                Git is Apple's or Homebrew's to update.
//
// Every action answers { ok, error, kind } and never throws. `kind` names what went wrong (network, proxy, permission,
// disk, package-manager, cancelled, other) so the row can say it in one line.

public struct Installer: Sendable {
    public var url: String
    public var interpreter: String
    public var env: [String: String]
    public init(url: String, interpreter: String, env: [String: String]) { self.url = url; self.interpreter = interpreter; self.env = env }
}

public let INSTALLERS: [String: Installer] = [
    "claude": Installer(url: "https://claude.ai/install.sh", interpreter: "bash", env: [:]),
    "codex": Installer(url: "https://chatgpt.com/codex/install.sh", interpreter: "sh", env: ["CODEX_NON_INTERACTIVE": "1"]),
]
let INSTALL_TIMEOUT: TimeInterval = 10 * 60
public let GIT_WAIT: TimeInterval = 60 * 60
public let GIT_POLL: TimeInterval = 5
private let GiB: Double = 1024 * 1024 * 1024
/// Free space needed before starting: an agent is ~250-350 MB a version; Apple's tools want several GB while installing.
public let NEEDS_BYTES: [String: Double] = ["git": 5 * GiB, "claude": GiB, "codex": GiB]
let APPLE_INSTALLER = "Install Command Line Developer Tools"

public struct ActionResult: Equatable, Sendable {
    public var ok: Bool
    public var error: String?
    public var kind: String?
    public init(ok: Bool, error: String? = nil, kind: String? = nil) { self.ok = ok; self.error = error; self.kind = kind }
    public static let done = ActionResult(ok: true)
}

private func lastLines(_ text: String, _ count: Int = 3) -> [String] { Array(nonEmptyLines(stripANSI(text)).suffix(count)) }

/// One line saying what went wrong, from what the installer printed.
public func classifyFailure(_ text: String, _ code: Int32? = nil) -> (kind: String, error: String) {
    let output = text
    let detail = lastLines(output, 1).first ?? (code.map { "exit status \($0)" } ?? "")
    let tail = detail.isEmpty ? "" : " (\(detail.prefixChars(160)))"
    if Rx.i(#"\b407\b|proxy"#).test(output) { return ("proxy", "A proxy stopped the download\(tail).") }
    if Rx.i(#"ssl|certificate|curl: \((35|51|58|59|60|77|83)\)"#).test(output) {
        return ("network", "The download failed its certificate check; a proxy or firewall may be in the way\(tail).")
    }
    if Rx.i(#"could not resolve|failed to connect|connection (refused|reset|timed out)|network is unreachable|timed out|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|curl: \((5|6|7|28|52|55|56)\)"#).test(output) {
        return ("network", "The installer could not be reached: no internet connection\(tail).")
    }
    if Rx.i(#"ENOSPC|no space left"#).test(output) { return ("disk", "The disk is full\(tail).") }
    if Rx.i(#"EACCES|EPERM|permission denied|operation not permitted|not writable"#).test(output) {
        return ("permission", "Engelbart was not allowed to write where it installs\(tail).")
    }
    if Rx.i(#"npm (ERR!|error)|brew|homebrew|cask"#).test(output) { return ("package-manager", "The package manager failed\(tail).") }
    return ("other", "It did not finish\(tail).")
}

func failure(_ text: String, _ code: Int32?) -> ActionResult {
    let (kind, error) = classifyFailure(text, code)
    return ActionResult(ok: false, error: error, kind: kind)
}

/// Free bytes on the disk holding `path`, or nil when that cannot be told (the installer will say if it runs out).
public var freeBytesProvider: (String) -> Double? = { path in
    var stats = statfs()
    guard statfs(path, &stats) == 0 else { return nil }
    return Double(stats.f_bavail) * Double(stats.f_bsize)
}

public func freeBytes(_ path: String) -> Double? { freeBytesProvider(path) }

/// nil, or a failure when the disk holding `where` has less room than the tool needs.
public func roomFor(_ name: String, _ where_: String) -> ActionResult? {
    guard let free = freeBytes(where_), let needs = NEEDS_BYTES[name], free < needs else { return nil }
    let gb = { (bytes: Double) in String(format: "%.1f GB", bytes / GiB) }
    return ActionResult(ok: false, error: "\(Requirements[name].name) needs about \(gb(needs)) free; \(gb(free)) is left.", kind: "disk")
}

/// What installs and updates; the real ones below, or the pretend machine (Fake.swift).
public protocol ToolActions: AnyObject, Sendable {
    /// Apple's dialog, then waiting for it. `onPhase(text)` reports what it is waiting for.
    func installGit(onPhase: @escaping @Sendable (String) -> Void) async -> ActionResult
    func installAgent(_ name: String) async -> ActionResult
    /// The CLI's own updater, run by the path Engelbart runs it by.
    func updateAgent(_ name: String, _ file: String?) async -> ActionResult
    func updateGit(_ source: String?) async -> ActionResult
}

public final class ToolInstaller: ToolActions, @unchecked Sendable {
    let runner: ToolRunning
    let home: String
    let tmpDir: String
    let installers: [String: Installer]
    let sleep: @Sendable (TimeInterval) async -> Void
    let now: @Sendable () -> TimeInterval
    let gitWait: TimeInterval
    let gitPoll: TimeInterval

    /// `installers`: where each agent's installer is fetched from (INSTALLERS; tests give local pretend ones).
    /// `now` is seconds on any clock (tests advance it with `sleep`).
    public init(runner: ToolRunning, home: String = NSHomeDirectory(), tmpDir: String = NSTemporaryDirectory(), installers: [String: Installer] = INSTALLERS,
                sleep: @escaping @Sendable (TimeInterval) async -> Void = pause,
                now: @escaping @Sendable () -> TimeInterval = { Date().timeIntervalSince1970 }, gitWait: TimeInterval = GIT_WAIT, gitPoll: TimeInterval = GIT_POLL) {
        self.runner = runner; self.home = home; self.tmpDir = tmpDir; self.installers = installers
        self.sleep = sleep; self.now = now; self.gitWait = gitWait; self.gitPoll = gitPoll
    }

    func gitArrived() async -> Bool {
        let selected = await runner.exec("/usr/bin/xcode-select", ["-p"], env: [:], timeout: 5)
        let developer = selected.code == 0 ? (selected.stdout.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").first ?? "") : ""
        if developer.isEmpty { return false }
        return FileManager.default.isExecutableFile(atPath: (developer as NSString).appendingPathComponent("usr/bin/git"))
    }

    func appleInstallerRunning() async -> Bool {
        let out = await runner.exec("/usr/bin/pgrep", ["-f", APPLE_INSTALLER], env: [:], timeout: 5)
        return out.code == 0
    }

    public func installGit(onPhase: @escaping @Sendable (String) -> Void) async -> ActionResult {
        if let full = roomFor("git", "/Library") { return full }
        let asked = await runner.exec("/usr/bin/xcode-select", ["--install"], env: [:], timeout: 30)
        let said = "\(asked.stdout)\n\(asked.stderr)"
        let already = Rx.i("already installed").test(said)
        if asked.code != 0 && !already { return failure(said, asked.code) }
        if already, await gitArrived() { return .done }
        onPhase("Waiting for Apple’s installer")
        let started = now()
        var seen = false
        var gone = 0
        while now() - started < gitWait {
            await sleep(gitPoll)
            if await gitArrived() { return .done }
            if await appleInstallerRunning() { seen = true; gone = 0; continue }
            gone += 1
            // Closed without finishing (Not Now, or the window shut): twice in a row, so a restart of the process between
            // steps is not mistaken for it.
            if seen && gone >= 2 { return ActionResult(ok: false, error: "Apple’s installer was closed before it finished.", kind: "cancelled") }
            if !seen && now() - started > 60 { return ActionResult(ok: false, error: "Apple’s installer did not open.", kind: "other") }
        }
        return ActionResult(ok: false, error: "Apple’s installer had not finished after an hour.", kind: "other")
    }

    public func installAgent(_ name: String) async -> ActionResult {
        if let full = roomFor(name, home) { return full }
        guard let installer = installers[name] else { return ActionResult(ok: false, error: "It did not finish.", kind: "other") }
        let script = (tmpDir as NSString).appendingPathComponent("engelbart-\(name)-install-\(getpid())-\(Int(now() * 1000)).sh")
        defer { try? FileManager.default.removeItem(atPath: script) } // never downloaded: nothing to remove
        var env = ["ENGELBART_INSTALLER": script, "ENGELBART_INSTALLER_URL": installer.url]
        for (k, v) in installer.env { env[k] = v }
        let out = await runner.shell("curl -fsSL --retry 2 --connect-timeout 20 -o \"$ENGELBART_INSTALLER\" \"$ENGELBART_INSTALLER_URL\" && \(installer.interpreter) \"$ENGELBART_INSTALLER\" < /dev/null 2>&1",
                                     env: env, timeout: INSTALL_TIMEOUT)
        if out.timedOut { return ActionResult(ok: false, error: "The installer had not finished after \(Int(INSTALL_TIMEOUT / 60)) minutes.", kind: "other") }
        if out.marked == false { return ActionResult(ok: false, error: shellSilent(runner), kind: "other") } // it never ran
        if out.code != 0 { return failure("\(out.stdout)\n\(out.stderr)", out.code) }
        return .done
    }

    public func updateAgent(_ name: String, _ file: String?) async -> ActionResult {
        if let full = roomFor(name, home) { return full }
        let out = await runner.shell("exec \"$ENGELBART_TOOL\" update < /dev/null 2>&1", env: ["ENGELBART_TOOL": file ?? "", "CODEX_NON_INTERACTIVE": "1"], timeout: INSTALL_TIMEOUT)
        if out.timedOut { return ActionResult(ok: false, error: "The update had not finished after \(Int(INSTALL_TIMEOUT / 60)) minutes.", kind: "other") }
        if out.marked == false { return ActionResult(ok: false, error: shellSilent(runner), kind: "other") }
        if out.code != 0 { return failure("\(out.stdout)\n\(out.stderr)", out.code) }
        return .done
    }

    public func updateGit(_ source: String?) async -> ActionResult {
        if source == "bundled" { return ActionResult(ok: false, error: "This Git came with Engelbart and is updated with it.", kind: "other") }
        if source != "homebrew" { return ActionResult(ok: false, error: "Apple’s Git is updated by macOS: System Settings › General › Software Update.", kind: "other") }
        let out = await runner.shell("brew upgrade git < /dev/null 2>&1", env: [:], timeout: INSTALL_TIMEOUT)
        if out.code != 0 { return failure("\(out.stdout)\n\(out.stderr)", out.code) }
        return .done
    }
}

// Putting a working version back (design D12). Both vendors' installers keep earlier versions on disk and reach the
// current one through a symlink: Claude Code's launcher ~/.local/bin/claude points into ~/.local/share/claude/versions/,
// Codex's ~/.codex/packages/standalone/current into releases/.

public struct RollbackOptions: Sendable {
    public var home: String
    public var env: [String: String]
    public init(home: String = NSHomeDirectory(), env: [String: String] = ProcessInfo.processInfo.environment) { self.home = home; self.env = env }
}

public struct RollbackMark: Equatable, Sendable {
    public let link: String
    public let target: String
}

public func rollbackPoint(_ name: String, _ options: RollbackOptions = RollbackOptions()) -> String? {
    if name == "claude" { return (options.home as NSString).appendingPathComponent(".local/bin/claude") }
    if name == "codex" { return (codexHome(env: options.env, home: options.home) as NSString).appendingPathComponent("packages/standalone/current") }
    return nil
}

/// What the rollback point points at now (to restore later), or nil when this install has none.
public func markRollback(_ name: String, _ options: RollbackOptions = RollbackOptions()) -> RollbackMark? {
    guard let link = rollbackPoint(name, options),
          let target = try? FileManager.default.destinationOfSymbolicLink(atPath: link) else { return nil }
    let resolved = target.hasPrefix("/") ? target : ((link as NSString).deletingLastPathComponent as NSString).appendingPathComponent(target)
    return FileManager.default.fileExists(atPath: resolved) ? RollbackMark(link: link, target: target) : nil
}

/// Points the link back where `mark` found it, in one rename. → true when it did.
@discardableResult
public func rollback(_ mark: RollbackMark?) -> Bool {
    guard let mark else { return false }
    let temporary = "\(mark.link).engelbart-\(getpid())"
    unlink(temporary)
    guard symlink(mark.target, temporary) == 0 else { return false }
    if rename(temporary, mark.link) != 0 { unlink(temporary); return false }
    return true
}
