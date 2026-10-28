import Foundation
import EngelbartCore

// Whether a browser's app is installed on this Mac, without ever holding up Engelbart (2026-10-12; installed-apps.cjs):
//   1. /Applications and ~/Applications are looked in first: the browser's known app name (its Info.plist naming its
//      bundle id, or unreadable, as a binary plist is), else any app there whose Info.plist names the bundle id.
//   2. Not there: Spotlight is asked in the background and its answer kept. Until it answers, the browser counts as
//      installed (what a Spotlight that cannot answer meant).
//   3. Before macOS is asked for a browser's key or a page is opened in it, its answer is waited for (`settled`), at most
//      `settleMs`: an uninstalled browser is never asked about or opened.

public final class InstalledApps: @unchecked Sendable {
    public static let appNames: [String: [String]] = [
        "com.google.Chrome": ["Google Chrome.app"], "com.brave.Browser": ["Brave Browser.app"], "com.microsoft.edgemac": ["Microsoft Edge.app"],
        "com.vivaldi.Vivaldi": ["Vivaldi.app"], "com.operasoftware.Opera": ["Opera.app"], "org.chromium.Chromium": ["Chromium.app"],
        "company.thebrowser.Browser": ["Arc.app"], "org.mozilla.firefox": ["Firefox.app"], "com.apple.Safari": ["Safari.app"], "ai.perplexity.comet": ["Comet.app"],
    ]
    public static let settleSeconds: TimeInterval = 2
    static let localSeconds: TimeInterval = 60
    static let spotlightSeconds: TimeInterval = 10 * 60

    public struct FS {
        public var readdir: (String) throws -> [String]
        public var readFile: (String) -> String?
        public var exists: (String) -> Bool
        public init(readdir: @escaping (String) throws -> [String], readFile: @escaping (String) -> String?, exists: @escaping (String) -> Bool) { self.readdir = readdir; self.readFile = readFile; self.exists = exists }
        public static let real = FS(readdir: { try FileManager.default.contentsOfDirectory(atPath: $0) }, readFile: { try? String(contentsOfFile: $0, encoding: .utf8) }, exists: { FileManager.default.fileExists(atPath: $0) })
    }

    let appDirs: [String]
    let spotlight: (String) async -> Bool
    let override: [String]?
    let fs: FS
    let settleMs: TimeInterval
    let now: () -> Date
    private let lock = NSLock()
    private var local: [String: (at: Date, path: String)] = [:]
    private var answers: [String: (at: Date, yes: Bool)] = [:]
    private var pending: [String: Task<Bool, Never>] = [:]

    /// `override`: bundle ids standing in for this Mac's apps (ENGELBART_INSTALLED_BROWSERS in scripted runs), or nil.
    public init(appDirs: [String] = ["/Applications", (NSHomeDirectory() as NSString).appendingPathComponent("Applications")],
                spotlight: @escaping (String) async -> Bool = InstalledApps.installedApp, override: [String]? = InstalledApps.environmentOverride(),
                fs: FS = .real, settleSeconds: TimeInterval = InstalledApps.settleSeconds, now: @escaping () -> Date = Date.init) {
        self.appDirs = appDirs; self.spotlight = spotlight; self.override = override; self.fs = fs; self.settleMs = settleSeconds; self.now = now
    }

    public static func environmentOverride() -> [String]? {
        guard let raw = ProcessInfo.processInfo.environment["ENGELBART_INSTALLED_BROWSERS"] else { return nil }
        return raw.split(separator: ",").map { JSStr.trim(String($0)) }.filter { !$0.isEmpty }
    }

    static func safeId(_ id: String) -> Bool { SRx(#"^[\w.-]+$"#).test(id) }

    /// Spotlight's answer for `bundleId`: an app with that id outside the Trash, still there. An error counts as installed.
    public static func installedApp(_ bundleId: String) async -> Bool {
        guard safeId(bundleId) else { return false }
        guard let result = try? await ProcessRunner.run("/usr/bin/mdfind", ["kMDItemCFBundleIdentifier == '\(bundleId)'"], timeout: 5), result.exit.succeeded else { return true }
        return result.stdout.split(separator: "\n").map { JSStr.trim(String($0)) }.contains { SRx(#"\.app$"#, "i").test($0) && !$0.contains("/.Trash/") && FileManager.default.fileExists(atPath: $0) }
    }

    /// Whether an Info.plist's text names `bundleId` (an XML plist; a binary one is not read → nil).
    public static func plistNames(_ text: String?, _ bundleId: String) -> Bool? {
        guard let m = SRx(#"<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>"#).match(text ?? "") else { return nil }
        return JSStr.trim(m[1] ?? "") == bundleId
    }

    func lookLocally(_ bundleId: String) -> String {
        for dir in appDirs {
            for name in InstalledApps.appNames[bundleId] ?? [] {
                let app = (dir as NSString).appendingPathComponent(name)
                if !fs.exists(app) { continue }
                if InstalledApps.plistNames(fs.readFile((app as NSString).appendingPathComponent("Contents/Info.plist")), bundleId) != false { return app }
            }
        }
        for dir in appDirs {
            guard let names = try? fs.readdir(dir) else { continue }
            for name in names where SRx(#"\.app$"#, "i").test(name) {
                let app = (dir as NSString).appendingPathComponent(name)
                if InstalledApps.plistNames(fs.readFile((app as NSString).appendingPathComponent("Contents/Info.plist")), bundleId) == true { return app }
            }
        }
        return ""
    }

    /// Where the app is in appDirs, or '' (kept a minute).
    public func where_(_ bundleId: String) -> String {
        lock.lock()
        if let known = local[bundleId], now().timeIntervalSince(known.at) < InstalledApps.localSeconds { lock.unlock(); return known.path }
        lock.unlock()
        let found = lookLocally(bundleId)
        lock.lock(); local[bundleId] = (now(), found); lock.unlock()
        return found
    }

    private func record(_ bundleId: String, _ yes: Bool) { lock.lock(); answers[bundleId] = (now(), yes); pending[bundleId] = nil; lock.unlock() }

    @discardableResult
    func askOne(_ bundleId: String) -> Task<Bool, Never> {
        lock.lock(); defer { lock.unlock() }
        if let answer = answers[bundleId], now().timeIntervalSince(answer.at) < InstalledApps.spotlightSeconds { return Task { answer.yes } }
        if let waiting = pending[bundleId] { return waiting }
        let task = Task { [weak self] () -> Bool in
            guard let self else { return true }
            let yes = await self.spotlight(bundleId)
            self.record(bundleId, yes)
            return yes
        }
        pending[bundleId] = task
        return task
    }

    /// Whether the browser counts as installed now: in appDirs, else Spotlight's answer, else (not answered yet) yes.
    public func has(_ bundleId: String) -> Bool {
        guard InstalledApps.safeId(bundleId) else { return false }
        if let override { return override.contains(bundleId) }
        if !where_(bundleId).isEmpty { return true }
        lock.lock(); let answer = answers[bundleId]; lock.unlock()
        if let answer {
            if now().timeIntervalSince(answer.at) >= InstalledApps.spotlightSeconds { askOne(bundleId) }
            return answer.yes
        }
        askOne(bundleId)
        return true
    }

    /// Spotlight asked about each browser not in appDirs, in the background (the choose screen opening).
    public func ask(_ bundleIds: [String] = Array(InstalledApps.appNames.keys)) async {
        if override != nil { return }
        let tasks = bundleIds.filter { InstalledApps.safeId($0) && where_($0).isEmpty }.map { askOne($0) }
        for task in tasks { _ = await task.value }
    }

    /// The browser's answer, waited for at most `maxSeconds` (no answer by then: installed).
    public func settled(_ bundleId: String, maxSeconds: TimeInterval? = nil) async -> Bool {
        guard InstalledApps.safeId(bundleId) else { return false }
        if let override { return override.contains(bundleId) }
        if !where_(bundleId).isEmpty { return true }
        let task = askOne(bundleId)
        let limit = maxSeconds ?? settleMs
        // Whichever comes first: Spotlight's answer, or the wait running out (installed). Spotlight goes on answering in
        // the background either way, and its answer is kept.
        return await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
            let once = Once()
            Task { let yes = await task.value; if once.take() { done.resume(returning: yes) } }
            Task { try? await Task.sleep(nanoseconds: UInt64(limit * 1_000_000_000)); if once.take() { done.resume(returning: true) } }
        }
    }
}

/// A flag that is taken once, from any thread.
final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var taken = false
    func take() -> Bool { lock.lock(); defer { lock.unlock() }; if taken { return false }; taken = true; return true }
}
