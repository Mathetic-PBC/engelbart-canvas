import Darwin
import EngelbartCore
import Foundation

// New versions (src/main/updates.cjs, 2026-09-28; docs/releasing-mac.md). A release is uploaded to one folder on the web
// with the feed written there (latest-mac.yml). The app checks it a minute after launch, every six hours after, and from
// Engelbart ▸ Check for Updates…. How a new version goes in depends on how this one was signed:
//
//   Developer ID  an updater (electron-updater in Electron; `UpdateChecker` here) downloads it in the background; it is
//                 installed when the app quits, and a dialog offers to restart now.
//   ad hoc        macOS installs an update only when it is signed like the app it replaces, which an ad hoc signature never
//                 is, so the new version comes the way the first one did: Update runs the install command (install.sh in
//                 the download folder) in the background while the app stays open, its download shown in every window
//                 (UpdateBanner.swift) and on the Dock. Once the new version is downloaded and checked the app asks to
//                 restart (MATH-43): Restart to Update quits, the app is replaced where it is and opens again; Later leaves
//                 the command waiting for as long as the app stays open, to install it at the next quit, which opens
//                 nothing (only Restart to Update leaves the command the file that says to open it again). Restart to
//                 Update from the menu or a banner asks about running terminal sessions, as any quit does; the ready
//                 dialog has said already. Restart to Update after the command has stopped (it was killed) runs it again,
//                 and the app quits by itself once that one is ready.
//
// Each version is offered once per launch; Later leaves it until the next. Nothing runs outside an .app bundle, in a build
// without a download folder, or with ENGELBART_UPDATES=off. For scripted runs only: a folder on this Mac
// (http://127.0.0.1:<port>/) is accepted, ENGELBART_CONFIRM_ALL=1 answers the dialogs with their first button, and
// ENGELBART_NO_OPEN=1 reaches the install command.
//
// The Swift app has no release feed yet (2026-10-28): the download folder is a setting, off by default
// (UpdateFeedSetting), so nothing is checked until one is set.

public let FIRST_CHECK: TimeInterval = 60
public let CHECK_EVERY: TimeInterval = 6 * 60 * 60
public let READY_POLL: TimeInterval = 0.5
let LOG_TAIL = 4096 // bytes of the log read for curl's progress bar

/// What the build says about where its new versions are: { downloads, developerId }.
public struct ReleaseInfo: Equatable, Sendable {
    public var downloads: String
    public var developerId: Bool
    public init(downloads: String, developerId: Bool) { self.downloads = downloads; self.developerId = developerId }

    private static let safe = Rx(#"^(https://[^\s"'`$\\]+|http://127\.0\.0\.1:\d+(/[^\s"'`$\\]*)?)/$"#)

    /// An https address ending in "/" (or a folder on this Mac for scripted runs), else nil: nothing is checked.
    public static func validated(downloads: String?, developerId: Bool) -> ReleaseInfo? {
        guard let downloads, safe.test(downloads) else { return nil }
        return ReleaseInfo(downloads: downloads, developerId: developerId)
    }

    /// package.json → engelbart, as Electron read it ({ downloads, developerId }).
    public static func from(json: JSONValue?) -> ReleaseInfo? {
        validated(downloads: json?["downloads"]?.string, developerId: json?["developerId"]?.bool == true)
    }
}

/// Where the Swift app's download folder comes from: the defaults key `engelbart.updates.downloads` (and
/// `engelbart.updates.developerId`), else Info.plist `EngelbartDownloads` / `EngelbartDeveloperID`. Neither is set by
/// default, so updates are off until a feed exists.
public enum UpdateFeedSetting {
    public static let downloadsKey = "engelbart.updates.downloads"
    public static let developerIdKey = "engelbart.updates.developerId"

    public static func read(bundle: Bundle = .main, defaults: UserDefaults = .standard) -> ReleaseInfo? {
        if let downloads = defaults.string(forKey: downloadsKey) {
            return ReleaseInfo.validated(downloads: downloads, developerId: defaults.bool(forKey: developerIdKey))
        }
        let plist = bundle.infoDictionary ?? [:]
        return ReleaseInfo.validated(downloads: plist["EngelbartDownloads"] as? String, developerId: (plist["EngelbartDeveloperID"] as? Bool) == true)
    }
}

/// The .app this process runs from (…/Engelbart.app/Contents/MacOS/Engelbart).
public func bundleOf(_ execPath: String) -> String {
    (((execPath as NSString).deletingLastPathComponent as NSString).appendingPathComponent("../..") as NSString).standardizingPath
}

/// The last lines the install command wrote, for a dialog (curl's progress bars left out).
public func updateLogLastLines(_ file: String, _ count: Int = 3) -> String {
    guard let text = try? String(contentsOfFile: file, encoding: .utf8) else { return "" }
    let bars = Rx(#"[#=]{8,}"#)
    return text.replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty && !bars.test($0) }.suffix(count).joined(separator: "\n")
}

/// curl's progress bar in the install command's log (`####   42.3%`, drawn again after each \r): the last percentage it
/// drew, or nil before the first. Only the end of the log is read.
public func lastPercent(_ file: String) -> Double? {
    guard let handle = FileHandle(forReadingAtPath: file) else { return nil }
    defer { try? handle.close() }
    guard let size = try? handle.seekToEnd() else { return nil }
    let length = min(size, UInt64(LOG_TAIL))
    try? handle.seek(toOffset: size - length)
    let data = (try? handle.read(upToCount: Int(length))) ?? Data()
    let found = Rx(#"\d{1,3}(?:[.,]\d+)?(?=%)"#).all(String(decoding: data, as: UTF8.self))
    guard let last = found.last, let value = Double(last.replacingOccurrences(of: ",", with: ".")), value >= 0, value <= 100 else { return nil }
    return value
}

/// What the banner and the menu show: { enabled, state, available, version, percent, dismissed }.
public struct UpdateSnapshot: Equatable, Sendable {
    public var enabled: Bool
    /// idle | checking | installing | ready (downloaded, or the install command waits for the quit)
    public var state: String
    /// The newer version, once seen.
    public var available: String?
    /// The one being installed, else the newer one seen.
    public var version: String?
    /// How much curl has downloaded (whole, 0–100), while installing, once it says.
    public var percent: Int?
    /// Later on a window's banner: hidden until the state changes.
    public var dismissed: Bool

    public init(enabled: Bool, state: String = "idle", available: String? = nil, version: String? = nil, percent: Int? = nil, dismissed: Bool = false) {
        self.enabled = enabled; self.state = state; self.available = available; self.version = version; self.percent = percent; self.dismissed = dismissed
    }

    public static let disabled = UpdateSnapshot(enabled: false)

    public var json: JSONValue {
        guard enabled || state != "idle" || available != nil else { return ["enabled": false] }
        return ["enabled": .bool(enabled), "state": .string(state), "available": available.map(JSONValue.string) ?? .null,
                "version": version.map(JSONValue.string) ?? .null, "percent": percent.map { .number(Double($0)) } ?? .null, "dismissed": .bool(dismissed)]
    }

    public init?(json: JSONValue?) {
        guard let json, json["enabled"] != nil else { return nil }
        self.init(enabled: json["enabled"]?.bool == true, state: json["state"]?.string ?? "idle", available: json["available"]?.string,
                  version: json["version"]?.string, percent: json["percent"]?.int, dismissed: json["dismissed"]?.bool == true)
    }
}

/// A message box: the app shows it as a sheet on the focused window (or alone) and answers the button's index.
public struct UpdateDialog: Equatable, Sendable {
    public var type: String
    public var message: String
    public var detail: String?
    public var buttons: [String]
    public var defaultId: Int?
    public var cancelId: Int?
}

/// The menu's item by state.
public struct UpdateMenuItem: Equatable, Sendable {
    public var label: String
    public var enabled: Bool
}

/// electron-updater's part: finds a newer version (and, for a Developer ID build, downloads it and installs it at quit).
/// Events come through `onAvailable` / `onDownloaded` during `checkForUpdates`.
@MainActor
public protocol UpdateChecker: AnyObject {
    var autoDownload: Bool { get set }
    var autoInstallOnAppQuit: Bool { get set }
    var onAvailable: ((String) -> Void)? { get set }
    var onDownloaded: ((String) -> Void)? { get set }
    /// The newer version, or nil when this one is the newest.
    func checkForUpdates() async throws -> String?
    func quitAndInstall()
}

/// The install command, started detached: it outlives the app, which it replaces.
public protocol UpdateCommand: AnyObject {
    var onExit: ((Int32?) -> Void)? { get set }
    var onError: ((String) -> Void)? { get set }
}

public typealias UpdateSpawner = (_ file: String, _ args: [String], _ env: [String: String], _ log: String) throws -> UpdateCommand

/// The feed electron-builder writes (latest-mac.yml): its `version:` line against this version. Ad hoc only: it never
/// downloads (the install command does).
@MainActor
public final class FeedChecker: UpdateChecker {
    public var autoDownload = false
    public var autoInstallOnAppQuit = false
    public var onAvailable: ((String) -> Void)?
    public var onDownloaded: ((String) -> Void)?
    let feed: URL
    let current: String
    let fetch: (URL) async throws -> String

    public init(downloads: String, current: String, fetch: @escaping (URL) async throws -> String = FeedChecker.download) {
        self.feed = URL(string: "\(downloads)latest-mac.yml")!
        self.current = current
        self.fetch = fetch
    }

    public static func download(_ url: URL) async throws -> String {
        let (data, response) = try await URLSession.shared.data(from: url)
        if let http = response as? HTTPURLResponse, http.statusCode != 200 { throw NSError(domain: "Engelbart", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "HttpError: \(http.statusCode) for \(url.absoluteString)"]) }
        return String(decoding: data, as: UTF8.self)
    }

    public func checkForUpdates() async throws -> String? {
        let text = try await fetch(feed)
        guard let line = Rx(#"^version:\s*['"]?([^'"\s]+)"#, [.anchorsMatchLines]).exec(text), let version = line[1] else {
            throw NSError(domain: "Engelbart", code: 1, userInfo: [NSLocalizedDescriptionKey: "The update feed has no version."])
        }
        guard let newer = parseVersion(version), let mine = parseVersion(current), compareVersions(newer, mine) > 0 else { return nil }
        onAvailable?(version)
        return version
    }

    /// Nothing downloads in the background here (no Developer ID updater in the Swift app yet).
    public func quitAndInstall() {}
}

/// The real install command: posix_spawn in a session of its own (detached), output to the log.
final class SpawnedCommand: UpdateCommand {
    var onExit: ((Int32?) -> Void)?
    var onError: ((String) -> Void)?
}

public func spawnDetached(_ file: String, _ args: [String], _ env: [String: String], _ log: String) throws -> UpdateCommand {
    let fd = open(log, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "\(String(cString: strerror(errno))): \(log)"]) }
    defer { close(fd) }
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_adddup2(&actions, fd, 1)
    posix_spawn_file_actions_adddup2(&actions, fd, 2)
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    defer { posix_spawnattr_destroy(&attr) }
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID))
    let argv = ([file] + args).map { strdup($0) } + [nil]
    let envp = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer { argv.forEach { free($0) }; envp.forEach { free($0) } }
    var pid: pid_t = 0
    let status = posix_spawn(&pid, file, &actions, &attr, argv, envp)
    guard status == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: String(cString: strerror(status))]) }
    let command = SpawnedCommand()
    Thread.detachNewThread {
        var st: Int32 = 0
        var r: pid_t
        repeat { r = waitpid(pid, &st, 0) } while r == -1 && errno == EINTR
        let signaled = (st & 0x7f) != 0 && (st & 0x7f) != 0x7f
        let code: Int32? = signaled ? nil : (st >> 8) & 0xff
        DispatchQueue.main.async { command.onExit?(code) }
    }
    return command
}

@MainActor
public final class Updates {
    public struct Options {
        /// The download folder; nil = nothing is checked (the Swift app's default).
        public var info: ReleaseInfo?
        /// Running from an .app bundle (Electron: app.isPackaged).
        public var packaged: Bool
        public var currentVersion: String
        /// Where update.log goes.
        public var logsDir: String
        /// The .app the install command replaces.
        public var appPath: String
        public var pid: Int32
        public var tmpDir: String
        public var env: [String: String]
        public init(info: ReleaseInfo?, packaged: Bool, currentVersion: String, logsDir: String = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Logs/Engelbart Swift"),
                    appPath: String = Bundle.main.bundlePath, pid: Int32 = getpid(), tmpDir: String = NSTemporaryDirectory(), env: [String: String] = ProcessInfo.processInfo.environment) {
            self.info = info; self.packaged = packaged; self.currentVersion = currentVersion; self.logsDir = logsDir; self.appPath = appPath
            self.pid = pid; self.tmpDir = tmpDir; self.env = env
        }
    }

    final class Run {
        let version: String
        var alive = true
        let reopen: String
        let warned: Bool
        init(version: String, reopen: String, warned: Bool) { self.version = version; self.reopen = reopen; self.warned = warned }
    }

    let info: ReleaseInfo?
    let options: Options
    let ask: (UpdateDialog) async -> Int
    let progress: (Double) -> Void
    let requestQuit: (_ update: Bool) async -> Bool
    let runningSessions: () -> Int
    let makeChecker: (ReleaseInfo) -> UpdateChecker
    let spawn: UpdateSpawner
    let setTimer: (TimeInterval, @escaping () -> Void) -> Void
    let setRepeat: (TimeInterval, @escaping () -> Void) -> Int
    let clearRepeat: (Int) -> Void
    public var onChange: (UpdateSnapshot) -> Void
    /// Where `engelbart:update` goes on every change (every window's banner); the app also rebuilds its menu in `onChange`.
    let hub: EventHub?

    var offered = Set<String>()
    var updater: UpdateChecker?
    public private(set) var state = "idle"
    var available: String?
    var manualCheck = false
    var run: Run?
    var runs = 0
    var percent: Int?
    var dismissed = false

    /// `ask`: a message box (the app's sheet); `progress`: the Dock's bar (2 = indeterminate, -1 = none, else 0…1);
    /// `requestQuit(update)`: the app's quit (true when it goes on to quit; `update` = the ready dialog said already that
    /// terminal sessions end); `runningSessions`: how many terminal sessions a restart would end.
    public init(options: Options, ask: @escaping (UpdateDialog) async -> Int, progress: @escaping (Double) -> Void = { _ in },
                requestQuit: @escaping (_ update: Bool) async -> Bool, runningSessions: @escaping () -> Int = { 0 },
                makeChecker: ((ReleaseInfo) -> UpdateChecker)? = nil, spawn: @escaping UpdateSpawner = spawnDetached,
                setTimer: ((TimeInterval, @escaping () -> Void) -> Void)? = nil, setRepeat: ((TimeInterval, @escaping () -> Void) -> Int)? = nil,
                clearRepeat: ((Int) -> Void)? = nil, hub: EventHub? = .shared, onChange: @escaping (UpdateSnapshot) -> Void = { _ in }) {
        self.options = options
        self.info = options.packaged && options.env["ENGELBART_UPDATES"] != "off" ? options.info : nil
        self.ask = ask
        self.progress = progress
        self.requestQuit = requestQuit
        self.runningSessions = runningSessions
        let current = options.currentVersion
        self.makeChecker = makeChecker ?? { FeedChecker(downloads: $0.downloads, current: current) }
        self.spawn = spawn
        self.setTimer = setTimer ?? { delay, fn in
            let timer = Timer(timeInterval: delay, repeats: false) { _ in fn() }
            RunLoop.main.add(timer, forMode: .common)
        }
        let timers = RepeatTimers()
        self.setRepeat = setRepeat ?? { every, fn in timers.add(every, fn) }
        self.clearRepeat = clearRepeat ?? { timers.remove($0) }
        self.onChange = onChange
        self.hub = hub
    }

    public var enabled: Bool { info != nil }

    func dialog(_ d: UpdateDialog) async -> Int {
        if options.env["ENGELBART_CONFIRM_ALL"] == "1" { return 0 } // scripted runs only
        return await ask(d)
    }

    func notify() {
        let now = snapshot()
        onChange(now)
        hub?.post(ToolsEvents.update, now.json)
    }
    func set(_ next: String) { if next != state { dismissed = false }; state = next; notify() }

    public func snapshot() -> UpdateSnapshot {
        UpdateSnapshot(enabled: info != nil, state: state, available: available, version: run?.version ?? available,
                       percent: state == "installing" ? percent : nil, dismissed: dismissed)
    }

    var logPath: String { (options.logsDir as NSString).appendingPathComponent("update.log") }

    /// Ad hoc: the install command, in the background. When it says the new version is ready the app asks to restart, or,
    /// `quitWhenReady` (Restart to Update ran it again), quits; `warned`: that Restart to Update was the ready dialog's. The
    /// command opens the new version once it is installed only if its reopen file is there then: Restart to Update writes
    /// it, and a quit that does not go ahead removes it.
    func runInstaller(_ version: String, quitWhenReady: Bool = false, warned: Bool = false) {
        guard let info else { return }
        try? FileManager.default.createDirectory(atPath: options.logsDir, withIntermediateDirectories: true)
        let log = logPath
        runs += 1
        let base = (options.tmpDir as NSString).appendingPathComponent("engelbart-update-\(options.pid)-\(Int(Time.ms()))-\(runs)")
        let ready = "\(base).ready"
        let reopen = "\(base).reopen"
        var env = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": options.env["HOME"] ?? NSHomeDirectory(), "TMPDIR": options.env["TMPDIR"] ?? NSTemporaryDirectory(),
                   "LANG": "en_US.UTF-8", "ENGELBART_DOWNLOADS": info.downloads, "ENGELBART_WAIT_PID": String(options.pid), "ENGELBART_APP_PATH": options.appPath,
                   "ENGELBART_READY_FILE": ready, "ENGELBART_REOPEN_FILE": reopen]
        if options.env["ENGELBART_NO_OPEN"] == "1" { env["ENGELBART_NO_OPEN"] = "1" }
        let current = Run(version: version, reopen: reopen, warned: warned)
        run = current
        percent = nil
        // Downloaded to a file and run from there: a download that fails is an error here, not an empty script run.
        let script = "script=$(mktemp \"${TMPDIR:-/tmp}/engelbart-install.XXXXXX\") && curl -fsSL --retry 2 --connect-timeout 20 -o \"$script\" \"${ENGELBART_DOWNLOADS}install.sh\" && exec /bin/bash \"$script\""
        var spawnError: String?
        var child: UpdateCommand?
        do { child = try spawn("/bin/bash", ["-c", script], env, log) } catch { spawnError = error.localizedDescription }
        set("installing")
        progress(2) // indeterminate, on the Dock icon, until curl draws its first percentage
        var poll = 0
        poll = setRepeat(READY_POLL) { [weak self] in
            guard let self else { return }
            if !FileManager.default.fileExists(atPath: ready) {
                guard let now = lastPercent(log), Int(now) != self.percent else { return }
                self.percent = Int(now)
                self.progress(Double(Int(now)) / 100)
                self.set("installing")
                return
            }
            self.clearRepeat(poll)
            try? FileManager.default.removeItem(atPath: ready)
            self.set("ready")
            self.progress(-1)
            if quitWhenReady { Task { await self.quitInto(current, current.warned) } }
            else { Task { await self.askRestart(version) } }
        }
        let failed = { [weak self] (message: String) in
            current.alive = false
            unlink(reopen) // no command left to read it
            guard let self, self.run === current, self.state == "installing" else { return }
            self.clearRepeat(poll)
            self.progress(-1)
            self.set("idle")
            Task { _ = await self.dialog(UpdateDialog(type: "warning", message: "Engelbart could not be updated", detail: message, buttons: ["OK"])) }
        }
        // Whether it still runs, whatever the state: once ready, Restart to Update needs it waiting for the quit.
        child?.onError = failed
        child?.onExit = { [weak self] code in
            current.alive = false
            unlink(reopen) // no command left to read it
            // Ready: it went on to replace the app, or it was stopped, and Restart to Update runs it again.
            guard let self, self.run === current, self.state == "installing" else { return }
            self.clearRepeat(poll)
            self.progress(-1)
            self.set("idle")
            if code != 0 {
                let lines = updateLogLastLines(log)
                let detail = "\(lines.isEmpty ? "The install command stopped (exit status \(code.map(String.init) ?? "null"))." : lines)\n\nThis version is still installed. The details are in \(log)."
                Task { _ = await self.dialog(UpdateDialog(type: "warning", message: "Engelbart \(version) could not be installed", detail: detail, buttons: ["OK"])) }
            }
        }
        if let spawnError { failed(spawnError) }
    }

    /// Ad hoc: the new version is ready and the install command waits for the quit. Later installs it at the next quit.
    func askRestart(_ version: String) async {
        let sessions = runningSessions()
        let response = await dialog(UpdateDialog(
            type: "info", message: "Engelbart \(version) is ready",
            detail: sessions > 0
                ? "Restarting ends \(sessions) running terminal session\(sessions == 1 ? "" : "s"), which cannot be recovered. Later, it is installed the next time you quit. Documents are already saved."
                : "Engelbart quits and opens again with it. Later, it is installed the next time you quit. Your projects and notes stay as they are.",
            buttons: ["Restart to Update", "Later"], defaultId: 0, cancelId: 1))
        if response == 0 { restart(warned: true) }
    }

    /// Ad hoc: quits into the install command `current`, whose reopen file Restart to Update has written. A quit that does
    /// not go ahead (Cancel on the terminal-session question, a quit already under way) takes it away again, and it is as if
    /// Later had been chosen: installed at the next quit, opening nothing.
    func quitInto(_ current: Run, _ warned: Bool) async {
        let quitting = await requestQuit(warned)
        if !quitting { unlink(current.reopen) }
    }

    /// Restart to Update (the ready dialog, `warned`; the menu; a window's banner). Ad hoc: the install command waiting for
    /// the quit gets it; one that has stopped since runs again, its download shown, and the app quits by itself once it is
    /// ready. Either way the command is told to open the new version once it is installed.
    @discardableResult
    public func restart(warned: Bool = false) -> Bool {
        guard let info, state == "ready" else { return false }
        if info.developerId { ensureUpdater().quitAndInstall(); return true }
        let waiting = run?.alive == true
        if !waiting, let version = run?.version ?? available { runInstaller(version, quitWhenReady: true, warned: warned) }
        if let reopen = run?.reopen { FileManager.default.createFile(atPath: reopen, contents: Data()) } // else it installs, and opens nothing
        if waiting, let run { Task { await self.quitInto(run, warned) } }
        return true
    }

    /// Later on a window's banner: every banner hides until the state changes. The menu keeps Restart to Update.
    @discardableResult
    public func later() -> UpdateSnapshot {
        if state == "ready" && !dismissed { dismissed = true; notify() }
        return snapshot()
    }

    /// `offer` from an event: the once-per-launch rule is applied now, the dialog shown after.
    func offerSoon(_ version: String) {
        if offered.contains(version) { return }
        offered.insert(version)
        Task { await self.offer(version, manual: true) }
    }

    func offer(_ version: String, manual: Bool = false) async {
        guard let info else { return }
        if !manual && offered.contains(version) { return }
        offered.insert(version)
        let developerId = info.developerId
        let response = await dialog(UpdateDialog(
            type: "info", message: developerId ? "Engelbart \(version) is ready" : "Engelbart \(version) is available",
            detail: developerId
                ? "Restart to finish updating, or it will be installed the next time you quit. Your projects and notes stay as they are."
                : "You have \(options.currentVersion). Engelbart downloads the new version, then quits and opens again with it. Your projects and notes stay as they are.",
            buttons: developerId ? ["Restart Now", "Later"] : ["Update", "Later"], defaultId: 0, cancelId: 1))
        if response != 0 { return }
        if developerId { set("ready"); ensureUpdater().quitAndInstall() } else { runInstaller(version) }
    }

    @discardableResult
    func ensureUpdater() -> UpdateChecker {
        if let updater { return updater }
        let made = makeChecker(info!)
        made.autoDownload = info!.developerId
        made.autoInstallOnAppQuit = info!.developerId
        // The checker calls these on the main actor while it checks, as electron-updater's events came: what they decide
        // (Check for Updates… offers what it finds itself) is read then, and only the dialog waits.
        made.onAvailable = { [weak self] version in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.available = version
                if !self.info!.developerId && !self.manualCheck { self.offerSoon(version) }
            }
        }
        made.onDownloaded = { [weak self] version in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.available = version
                self.set("ready")
                self.offerSoon(version)
            }
        }
        updater = made
        return made
    }

    /// `manual`: from the menu, which says what it found either way.
    @discardableResult
    public func check(manual: Bool = false) async -> UpdateSnapshot {
        guard info != nil, state == "idle" else { return snapshot() }
        set("checking")
        manualCheck = manual
        do {
            let newer = try await ensureUpdater().checkForUpdates()
            if let newer { available = newer }
            manualCheck = false
            if state == "checking" { set("idle") } // an offer taken meanwhile has moved it on
            if manual && newer == nil {
                _ = await dialog(UpdateDialog(type: "info", message: "Engelbart \(options.currentVersion) is the newest version.", buttons: ["OK"]))
            } else if manual, let newer, info!.developerId {
                _ = await dialog(UpdateDialog(type: "info", message: "Engelbart \(newer) is downloading.", detail: "You will be asked to restart when it is ready.", buttons: ["OK"]))
            } else if manual, let newer {
                await offer(newer, manual: true)
            }
        } catch {
            manualCheck = false
            if state == "checking" { set("idle") }
            if manual {
                let first = error.localizedDescription.components(separatedBy: "\n").first ?? ""
                _ = await dialog(UpdateDialog(type: "warning", message: "Engelbart could not check for updates", detail: first, buttons: ["OK"]))
            }
        }
        return snapshot()
    }

    /// A minute after launch, then every six hours. → whether updates run in this copy.
    @discardableResult
    public func start() -> Bool {
        guard info != nil else { return false }
        setTimer(FIRST_CHECK) { [weak self] in Task { await self?.check() } }
        _ = setRepeat(CHECK_EVERY) { [weak self] in Task { await self?.check() } }
        return true
    }

    /// The app menu's item, by state (Engelbart ▸ …, above Set Up Tools…). `perform` it when clicked.
    public func menuItem() -> UpdateMenuItem {
        if state == "ready" { return UpdateMenuItem(label: "Restart to Update", enabled: true) }
        if state == "installing" { return UpdateMenuItem(label: percent == nil ? "Downloading Update…" : "Downloading Update… \(percent!)%", enabled: false) }
        if state == "checking" { return UpdateMenuItem(label: "Checking for Updates…", enabled: false) }
        return UpdateMenuItem(label: "Check for Updates…", enabled: true)
    }

    /// The menu item's click.
    public func performMenuItem() {
        if state == "ready" { restart() }
        else if state == "idle" { Task { await check(manual: true) } }
    }
}

/// Repeating main-queue timers by number (setInterval / clearInterval).
final class RepeatTimers {
    private var timers: [Int: Timer] = [:]
    private var next = 0
    func add(_ every: TimeInterval, _ fn: @escaping () -> Void) -> Int {
        next += 1
        let t = Timer(timeInterval: every, repeats: true) { _ in fn() }
        RunLoop.main.add(t, forMode: .common)
        timers[next] = t
        return next
    }
    func remove(_ id: Int) { timers[id]?.invalidate(); timers[id] = nil }
}
