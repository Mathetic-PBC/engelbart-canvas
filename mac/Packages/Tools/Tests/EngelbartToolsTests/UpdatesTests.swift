import EngelbartCore
import XCTest
@testable import EngelbartTools

// test/updates.test.cjs (2026-09-28; MATH-43, 2026-10-05): the updater, the dialogs and the install command are faked.
@MainActor
final class UpdatesTests: XCTestCase {
    nonisolated static let DOWNLOADS = "https://example.com/engelbart/"

    final class FakeChecker: UpdateChecker {
        var autoDownload = false
        var autoInstallOnAppQuit = false
        var onAvailable: ((String) -> Void)?
        var onDownloaded: ((String) -> Void)?
        var checks = 0
        var installs = 0
        let found: String?
        init(_ found: String?) { self.found = found }
        func checkForUpdates() async throws -> String? {
            checks += 1
            if let found { if autoDownload { onDownloaded?(found) } else { onAvailable?(found) } }
            return found
        }
        func quitAndInstall() { installs += 1 }
    }

    final class FakeCommand: UpdateCommand {
        var onExit: ((Int32?) -> Void)?
        var onError: ((String) -> Void)?
        let file: String, args: [String], env: [String: String], log: String
        init(_ file: String, _ args: [String], _ env: [String: String], _ log: String) { self.file = file; self.args = args; self.env = env; self.log = log }
        func exit(_ code: Int32?) { onExit?(code) }
    }

    @MainActor final class H {
        var updates: Updates!
        var updater: FakeChecker
        var dialogs: [UpdateDialog] = []
        var answers: [Int]
        var quits: [Bool] = []
        var spawned: [FakeCommand] = []
        var repeats: [(() -> Void)?] = []
        var changes: [UpdateSnapshot] = []
        var bars: [Double] = []
        let logs = temp("engelbart-updates-")
        var log: String { "\(logs)/update.log" }
        init(found: String?, answers: [Int]) { updater = FakeChecker(found); self.answers = answers }
        func ready(_ n: Int = 0) -> String { spawned[n].env["ENGELBART_READY_FILE"]! }
        func reopen(_ n: Int = 0) -> String { spawned[n].env["ENGELBART_REOPEN_FILE"]! }
        func poll(_ n: Int) { repeats[n]?() }
    }

    func harness(info: ReleaseInfo? = ReleaseInfo(downloads: DOWNLOADS, developerId: false), packaged: Bool = true, answers: [Int] = [], found: String? = nil,
                 env: [String: String] = [:], runningSessions: Int = 0, quit: @escaping (Bool) -> Bool = { _ in true }) -> H {
        let h = H(found: found, answers: answers)
        var e = ["HOME": NSHomeDirectory()]
        for (k, v) in env { e[k] = v }
        let options = Updates.Options(info: info, packaged: packaged, currentVersion: "0.1.0", logsDir: h.logs, appPath: "/Applications/Engelbart.app", pid: getpid(), tmpDir: temp("engelbart-update-tmp-"), env: e)
        h.updates = Updates(options: options,
                            ask: { [unowned h] d in h.dialogs.append(d); return h.answers.isEmpty ? 1 : h.answers.removeFirst() },
                            progress: { [unowned h] in h.bars.append($0) },
                            requestQuit: { [unowned h] update in h.quits.append(update); return quit(update) },
                            runningSessions: { runningSessions },
                            makeChecker: { [unowned h] _ in h.updater },
                            spawn: { [unowned h] file, args, env, log in let c = FakeCommand(file, args, env, log); h.spawned.append(c); return c },
                            setTimer: { _, _ in }, setRepeat: { [unowned h] _, fn in h.repeats.append(fn); return h.repeats.count },
                            clearRepeat: { [unowned h] id in if id > 0 && id <= h.repeats.count { h.repeats[id - 1] = nil } },
                            onChange: { [unowned h] in h.changes.append($0) })
        return h
    }

    /// setImmediate: lets the dialogs' and offers' tasks run.
    func tick() async { for _ in 0..<30 { await Task.yield() }; try? await Task.sleep(nanoseconds: 5_000_000); for _ in 0..<30 { await Task.yield() } }

    /// An ad hoc build that found 0.2.0 and was told Update (then `answers` for the dialogs after).
    func updating(answers: [Int] = [], runningSessions: Int = 0, quit: @escaping (Bool) -> Bool = { _ in true }) async -> H {
        let h = harness(answers: [0] + answers, found: "0.2.0", runningSessions: runningSessions, quit: quit)
        await h.updates.check()
        await tick()
        return h
    }

    func testReleaseInfoTheDownloadFolderIsAnHttpsAddressEndingInSlash() {
        XCTAssertEqual(ReleaseInfo.from(json: ["downloads": .string(Self.DOWNLOADS), "developerId": true]), ReleaseInfo(downloads: Self.DOWNLOADS, developerId: true))
        XCTAssertEqual(ReleaseInfo.from(json: ["downloads": "http://127.0.0.1:8767/"]), ReleaseInfo(downloads: "http://127.0.0.1:8767/", developerId: false), "a folder on this Mac, for scripted runs")
        for bad: JSONValue in [nil, ["downloads": nil], ["downloads": "http://example.com/e/"], ["downloads": "http://127.0.0.1.example.com/"], ["downloads": "https://example.com/e"], ["downloads": "https://example.com/$(x)/"]] {
            XCTAssertNil(ReleaseInfo.from(json: bad), bad.text())
        }
        XCTAssertEqual(bundleOf("/Applications/Engelbart.app/Contents/MacOS/Engelbart"), "/Applications/Engelbart.app")
    }

    func testTheFeedIsASettingOffByDefault() {
        let defaults = UserDefaults(suiteName: "engelbart-tools-test-\(UUID().uuidString)")!
        XCTAssertNil(UpdateFeedSetting.read(bundle: Bundle(for: Self.self), defaults: defaults), "no feed set: nothing is checked")
        defaults.set("https://example.com/engelbart-swift/", forKey: UpdateFeedSetting.downloadsKey)
        XCTAssertEqual(UpdateFeedSetting.read(bundle: Bundle(for: Self.self), defaults: defaults), ReleaseInfo(downloads: "https://example.com/engelbart-swift/", developerId: false))
        defaults.set("https://example.com/no-slash", forKey: UpdateFeedSetting.downloadsKey)
        XCTAssertNil(UpdateFeedSetting.read(bundle: Bundle(for: Self.self), defaults: defaults))
    }

    func testNothingRunsOutsideAnAppWithoutAFolderOrWithUpdatesOff() async {
        for h in [harness(packaged: false, found: "0.2.0"), harness(info: nil, found: "0.2.0"), harness(found: "0.2.0", env: ["ENGELBART_UPDATES": "off"])] {
            XCTAssertFalse(h.updates.enabled)
            XCTAssertFalse(h.updates.start())
            await h.updates.check(manual: true)
            XCTAssertEqual(h.updater.checks, 0)
            XCTAssertEqual(h.updates.snapshot().json, ["enabled": false])
        }
    }

    func testAdHocANewVersionIsOfferedOncePerLaunchAndUpdateShowsItsDownload() async {
        let later = harness(answers: [1], found: "0.2.0")
        await later.updates.check()
        await tick()
        XCTAssertEqual(later.dialogs.count, 1)
        XCTAssertEqual(later.dialogs[0].message, "Engelbart 0.2.0 is available")
        XCTAssertEqual(later.dialogs[0].detail, "You have 0.1.0. Engelbart downloads the new version, then quits and opens again with it. Your projects and notes stay as they are.")
        XCTAssertEqual(later.dialogs[0].buttons, ["Update", "Later"])
        XCTAssertFalse(later.updater.autoDownload, "macOS would refuse an ad hoc update: the checker only looks")
        await later.updates.check()
        await tick()
        XCTAssertEqual(later.dialogs.count, 1, "Later: not asked again this launch")

        let h = await updating()
        XCTAssertEqual(h.dialogs.count, 1)
        XCTAssertEqual(h.spawned.count, 1)
        let c = h.spawned[0]
        XCTAssertEqual(c.file, "/bin/bash")
        XCTAssertEqual(c.args[1], "script=$(mktemp \"${TMPDIR:-/tmp}/engelbart-install.XXXXXX\") && curl -fsSL --retry 2 --connect-timeout 20 -o \"$script\" \"${ENGELBART_DOWNLOADS}install.sh\" && exec /bin/bash \"$script\"")
        XCTAssertEqual([c.env["ENGELBART_DOWNLOADS"], c.env["ENGELBART_WAIT_PID"], c.env["ENGELBART_APP_PATH"], c.env["PATH"], c.env["LANG"]],
                       [Self.DOWNLOADS, String(getpid()), "/Applications/Engelbart.app", "/usr/bin:/bin:/usr/sbin:/sbin", "en_US.UTF-8"])
        XCTAssertNil(c.env["ENGELBART_NO_OPEN"])
        XCTAssertEqual(c.log, h.log)
        XCTAssertEqual(h.updates.snapshot(), UpdateSnapshot(enabled: true, state: "installing", available: "0.2.0", version: "0.2.0", percent: nil, dismissed: false))
        XCTAssertEqual(h.updates.menuItem(), UpdateMenuItem(label: "Downloading Update…", enabled: false))
        XCTAssertEqual(h.bars, [2], "indeterminate on the Dock until curl says how far it is")

        let before = h.changes.count
        h.poll(0)
        XCTAssertEqual(h.changes.count, before, "nothing downloaded yet: nothing to tell")
        write(h.log, "Downloading Engelbart 0.2.0 for Apple silicon Macs…\n\r##                    12.0%\r#########             42.3%")
        h.poll(0)
        XCTAssertEqual(h.updates.snapshot().percent, 42)
        XCTAssertEqual(h.changes.count, before + 1)
        XCTAssertEqual([h.changes.last?.state, h.changes.last?.percent.map(String.init)], ["installing", "42"], "the windows hear of it")
        XCTAssertEqual(h.bars.last, 0.42)
        XCTAssertEqual(h.updates.menuItem(), UpdateMenuItem(label: "Downloading Update… 42%", enabled: false))
        let handle = FileHandle(forWritingAtPath: h.log)!
        handle.seekToEndOfFile(); handle.write(Data("\r#########             42.9%".utf8)); try? handle.close()
        h.poll(0)
        XCTAssertEqual(h.changes.count, before + 1, "told again only when the whole percentage changes")
        XCTAssertEqual(h.quits.count, 0, "still downloading")
    }

    func testAdHocOnceReadyTheAppAsksAndRestartToUpdateQuitsWithoutTheSessionQuestion() async {
        let h = await updating(answers: [0])
        write(h.ready(), "")
        h.poll(0)
        await tick()
        XCTAssertFalse(FileManager.default.fileExists(atPath: h.ready()))
        XCTAssertEqual(h.updates.snapshot().state, "ready")
        XCTAssertEqual(h.bars.last, -1, "the Dock bar is cleared")
        XCTAssertEqual(h.dialogs.count, 2)
        XCTAssertEqual(h.dialogs[1].message, "Engelbart 0.2.0 is ready")
        XCTAssertEqual(h.dialogs[1].buttons, ["Restart to Update", "Later"])
        XCTAssertEqual([h.dialogs[1].defaultId, h.dialogs[1].cancelId], [0, 1])
        XCTAssertFalse(h.dialogs[1].detail!.contains("terminal"), "no terminal sessions to speak of")
        XCTAssertEqual(h.quits, [true])
        try? FileManager.default.removeItem(atPath: h.reopen())
    }

    func testAdHocLaterLeavesItReadyAndTheBannersLaterOnlyHidesTheBanner() async {
        let h = await updating(answers: [1])
        write(h.ready(), "")
        h.poll(0)
        await tick()
        XCTAssertEqual(h.dialogs[1].message, "Engelbart 0.2.0 is ready")
        XCTAssertEqual(h.quits.count, 0)
        XCTAssertEqual(h.updates.snapshot().state, "ready")
        XCTAssertEqual(h.updates.menuItem().label, "Restart to Update")
        XCTAssertFalse(h.updates.snapshot().dismissed, "the banner still offers it")
        let before = h.changes.count
        h.updates.later()
        XCTAssertEqual([h.updates.snapshot().state, String(h.updates.snapshot().dismissed), String(h.changes.count)], ["ready", "true", String(before + 1)])
        XCTAssertEqual(h.updates.menuItem().label, "Restart to Update", "the menu keeps it")
        XCTAssertFalse(FileManager.default.fileExists(atPath: h.reopen()), "Later: no reopen file, so the next quit installs it and opens nothing")
        h.updates.performMenuItem()
        await tick()
        XCTAssertEqual(h.quits, [false], "the install command still waits: the menu quits into it, asking about terminal sessions as any quit does")
        XCTAssertEqual(h.spawned.count, 1)
        try? FileManager.default.removeItem(atPath: h.reopen())
    }

    func testAdHocRestartWritesTheReopenFileAndAQuitThatDoesNotGoAheadRemovesIt() async {
        final class Box { var goesAhead = false; var marked: [Bool] = []; var h: H? }
        let box = Box()
        let h = await updating(answers: [1], quit: { _ in box.marked.append(FileManager.default.fileExists(atPath: box.h!.reopen())); return box.goesAhead })
        box.h = h
        XCTAssertEqual((h.reopen() as NSString).deletingLastPathComponent, (h.ready() as NSString).deletingLastPathComponent, "next to the ready file")
        XCTAssertEqual(((h.reopen() as NSString).lastPathComponent as NSString).deletingPathExtension, ((h.ready() as NSString).lastPathComponent as NSString).deletingPathExtension, "one name for the run")
        XCTAssertTrue(Rx("^engelbart-update-\(getpid())-\\d+-\\d+\\.reopen$").test((h.reopen() as NSString).lastPathComponent))
        write(h.ready(), "")
        h.poll(0)
        await tick()
        XCTAssertFalse(FileManager.default.fileExists(atPath: h.reopen()), "Later: none")
        h.updates.performMenuItem() // Cancel on the terminal-session question
        await tick()
        XCTAssertEqual(h.quits, [false])
        XCTAssertEqual(box.marked, [true])
        XCTAssertFalse(FileManager.default.fileExists(atPath: h.reopen()), "the quit did not go ahead: removed")
        XCTAssertEqual([h.updates.snapshot().state, h.updates.menuItem().label], ["ready", "Restart to Update"], "still waiting for the next quit")
        box.goesAhead = true
        XCTAssertTrue(h.updates.restart()) // a window's banner
        await tick()
        XCTAssertEqual(h.quits, [false, false])
        XCTAssertEqual(box.marked, [true, true])
        XCTAssertTrue(FileManager.default.fileExists(atPath: h.reopen()), "quitting: left for the install command, to open the new version")
        XCTAssertEqual(h.spawned.count, 1)
        try? FileManager.default.removeItem(atPath: h.reopen())
    }

    func testAdHocTheReadyDialogNamesTheRunningTerminalSessions() async {
        let h = await updating(answers: [1], runningSessions: 2)
        write(h.ready(), "")
        h.poll(0)
        await tick()
        XCTAssertEqual(h.dialogs[1].detail, "Restarting ends 2 running terminal sessions, which cannot be recovered. Later, it is installed the next time you quit. Documents are already saved.")
        let one = await updating(answers: [1], runningSessions: 1)
        write(one.ready(), "")
        one.poll(0)
        await tick()
        XCTAssertTrue(one.dialogs[1].detail!.hasPrefix("Restarting ends 1 running terminal session, which"))
    }

    func testAdHocRestartWhileTheCommandWaitsQuitsIntoItAndStartsNothing() async {
        let h = await updating(answers: [1])
        write(h.ready(), "")
        h.poll(0)
        await tick()
        XCTAssertTrue(h.updates.restart())
        await tick()
        XCTAssertEqual(h.quits, [false], "from a banner: the terminal-session question, as any quit")
        XCTAssertEqual(h.spawned.count, 1)
        try? FileManager.default.removeItem(atPath: h.reopen())
    }

    func testAdHocACommandStoppedAfterReadyDownloadsAgainThenQuitsByItself() async {
        let h = await updating(answers: [1])
        write(h.ready(), "")
        h.poll(0)
        await tick()
        h.spawned[0].exit(1) // killed, or it failed while it waited
        await tick()
        XCTAssertEqual(h.updates.snapshot().state, "ready")
        XCTAssertEqual(h.updates.menuItem().label, "Restart to Update")
        XCTAssertEqual(h.dialogs.count, 2, "no failure dialog: it was ready")
        h.updates.performMenuItem()
        XCTAssertEqual(h.quits.count, 0, "nothing waits for the quit yet")
        XCTAssertEqual(h.spawned.count, 2, "the install command runs again")
        XCTAssertEqual([h.updates.snapshot().state, h.updates.snapshot().version], ["installing", "0.2.0"], "the banner shows the download again")
        XCTAssertNotEqual(h.ready(1), h.ready(0))
        XCTAssertNotEqual(h.reopen(1), h.reopen(0))
        XCTAssertEqual([FileManager.default.fileExists(atPath: h.reopen(0)), FileManager.default.fileExists(atPath: h.reopen(1))], [false, true], "the reopen file is the new run's")
        write(h.ready(1), "")
        h.poll(1)
        await tick()
        XCTAssertEqual(h.quits, [false], "from the menu: the terminal-session question comes now, once it is ready")
        XCTAssertEqual(h.dialogs.count, 2, "Restart to Update was asked for already: no second dialog")
        try? FileManager.default.removeItem(atPath: h.reopen(1))
    }

    func testAdHocTheReadyDialogsRestartAfterTheCommandStoppedDownloadsAgainThenQuitsWithoutTheQuestion() async {
        let h = await updating(answers: [0])
        write(h.ready(), "")
        h.poll(0)
        h.spawned[0].exit(1) // stopped while the dialog was open
        await tick()
        XCTAssertEqual(h.spawned.count, 2, "the install command runs again")
        XCTAssertTrue(FileManager.default.fileExists(atPath: h.reopen(1)))
        write(h.ready(1), "")
        h.poll(1)
        await tick()
        XCTAssertEqual(h.quits, [true], "the dialog said already")
        try? FileManager.default.removeItem(atPath: h.reopen(1))
    }

    func testAdHocWhenTheQuitAfterASecondRunDoesNotGoAheadItsReopenFileIsRemoved() async {
        let h = await updating(answers: [1], quit: { _ in false })
        write(h.ready(), "")
        h.poll(0)
        await tick()
        h.spawned[0].exit(1)
        h.updates.restart()
        XCTAssertTrue(FileManager.default.fileExists(atPath: h.reopen(1)))
        write(h.ready(1), "")
        h.poll(1)
        await tick()
        XCTAssertEqual(h.quits, [false])
        XCTAssertFalse(FileManager.default.fileExists(atPath: h.reopen(1)))
        XCTAssertEqual(h.updates.snapshot().state, "ready", "it waits for the next quit")
    }

    func testAdHocARestartWhoseSecondRunFailsBeforeReadySaysWhyAndGoesBackToIdle() async {
        let h = await updating(answers: [1])
        write(h.ready(), "")
        h.poll(0)
        await tick()
        h.spawned[0].exit(0)
        h.updates.restart()
        h.spawned[1].exit(1)
        await tick()
        XCTAssertEqual(h.updates.snapshot().state, "idle")
        XCTAssertEqual(h.dialogs.last?.message, "Engelbart 0.2.0 could not be installed")
        XCTAssertEqual(h.quits.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: h.reopen(1)), "no reopen file left behind")
        h.spawned[0].onError?("late")
        await tick()
        XCTAssertEqual(h.dialogs.last?.message, "Engelbart 0.2.0 could not be installed", "the first run says nothing more")
    }

    func testAdHocACommandThatFailsBeforeReadySaysWhyAndLeavesThisVersionRunning() async {
        let h = harness(answers: [0], found: "0.2.0")
        await h.updates.check()
        await tick()
        write(h.log, "Downloading Engelbart 0.2.0 for Apple silicon Macs…\n######################## 100.0%\n\nEngelbart was not installed: the download does not match its checksum; run the command again.\n")
        h.spawned[0].exit(1)
        await tick()
        XCTAssertEqual(h.quits.count, 0)
        XCTAssertEqual(h.updates.snapshot().state, "idle")
        XCTAssertEqual(h.dialogs[1].message, "Engelbart 0.2.0 could not be installed")
        XCTAssertTrue(h.dialogs[1].detail!.contains("does not match its checksum"))
        XCTAssertFalse(h.dialogs[1].detail!.contains("#####"), "curl's progress bar is left out")
        XCTAssertTrue(h.dialogs[1].detail!.hasSuffix("\n\nThis version is still installed. The details are in \(h.log)."))
        let empty = harness(answers: [0], found: "0.2.0")
        await empty.updates.check()
        await tick()
        empty.spawned[0].exit(2)
        await tick()
        XCTAssertTrue(empty.dialogs[1].detail!.hasPrefix("The install command stopped (exit status 2)."))
    }

    func testASpawnThatFailsSaysEngelbartCouldNotBeUpdated() async {
        let h = harness(answers: [0], found: "0.2.0")
        let options = Updates.Options(info: ReleaseInfo(downloads: Self.DOWNLOADS, developerId: false), packaged: true, currentVersion: "0.1.0", logsDir: h.logs, tmpDir: temp(), env: [:])
        var dialogs: [UpdateDialog] = []
        let updates = Updates(options: options, ask: { dialogs.append($0); return 0 }, requestQuit: { _ in true }, makeChecker: { _ in FakeChecker("0.2.0") },
                              spawn: { _, _, _, _ in throw NSError(domain: "x", code: 1, userInfo: [NSLocalizedDescriptionKey: "spawn /bin/bash ENOENT"]) },
                              setTimer: { _, _ in }, setRepeat: { _, _ in 1 }, clearRepeat: { _ in })
        await updates.check()
        await tick()
        XCTAssertEqual(updates.snapshot().state, "idle")
        XCTAssertEqual(dialogs.last, UpdateDialog(type: "warning", message: "Engelbart could not be updated", detail: "spawn /bin/bash ENOENT", buttons: ["OK"], defaultId: nil, cancelId: nil))
    }

    func testCheckForUpdatesSaysWhatItFoundAndOffersANewVersionOnce() async {
        let none = harness()
        await none.updates.check(manual: true)
        XCTAssertEqual(none.dialogs[0].message, "Engelbart 0.1.0 is the newest version.")
        let some = harness(answers: [1], found: "0.3.0")
        await some.updates.check(manual: true)
        await tick()
        XCTAssertEqual(some.dialogs.count, 1, "one dialog, not one from the event and one from the menu")
        XCTAssertEqual(some.dialogs[0].message, "Engelbart 0.3.0 is available")
        await some.updates.check(manual: true)
        await tick()
        XCTAssertEqual(some.dialogs.count, 2, "asked for: offered again")
        XCTAssertEqual(some.updates.menuItem(), UpdateMenuItem(label: "Check for Updates…", enabled: true))
    }

    final class Failing: UpdateChecker {
        var autoDownload = false
        var autoInstallOnAppQuit = false
        var onAvailable: ((String) -> Void)?
        var onDownloaded: ((String) -> Void)?
        func checkForUpdates() async throws -> String? { throw NSError(domain: "x", code: 1, userInfo: [NSLocalizedDescriptionKey: "net::ERR_INTERNET_DISCONNECTED\nmore"]) }
        func quitAndInstall() {}
    }

    func testACheckThatFailsSaysSoOnlyWhenAskedFor() async {
        var dialogs: [UpdateDialog] = []
        let updates = Updates(options: Updates.Options(info: ReleaseInfo(downloads: Self.DOWNLOADS, developerId: false), packaged: true, currentVersion: "0.1.0", env: [:]),
                              ask: { dialogs.append($0); return 0 }, requestQuit: { _ in true }, makeChecker: { _ in Failing() }, setTimer: { _, _ in }, setRepeat: { _, _ in 1 }, clearRepeat: { _ in })
        await updates.check()
        XCTAssertEqual(dialogs.count, 0)
        XCTAssertEqual(updates.snapshot().state, "idle")
        await updates.check(manual: true)
        XCTAssertEqual(dialogs.last, UpdateDialog(type: "warning", message: "Engelbart could not check for updates", detail: "net::ERR_INTERNET_DISCONNECTED", buttons: ["OK"], defaultId: nil, cancelId: nil))
    }

    func testDeveloperIDTheUpdaterDownloadsByItselfAndRestartNowInstallsAtOnce() async {
        let h = harness(info: ReleaseInfo(downloads: Self.DOWNLOADS, developerId: true), answers: [0], found: "0.2.0")
        await h.updates.check()
        await tick()
        XCTAssertEqual([h.updater.autoDownload, h.updater.autoInstallOnAppQuit], [true, true])
        XCTAssertEqual(h.dialogs[0].message, "Engelbart 0.2.0 is ready")
        XCTAssertEqual(h.dialogs[0].buttons, ["Restart Now", "Later"])
        XCTAssertEqual(h.updater.installs, 1)
        XCTAssertEqual(h.spawned.count, 0, "no install command")
        let manual = harness(info: ReleaseInfo(downloads: Self.DOWNLOADS, developerId: true), answers: [1, 0], found: "0.2.0")
        await manual.updates.check(manual: true)
        await tick()
        XCTAssertTrue(manual.dialogs.contains { $0.message == "Engelbart 0.2.0 is downloading." && $0.detail == "You will be asked to restart when it is ready." })
    }

    func testEveryChangeReachesEveryWindowsBanner() async {
        let hub = EventHub()
        let updates = Updates(options: Updates.Options(info: ReleaseInfo(downloads: Self.DOWNLOADS, developerId: false), packaged: true, currentVersion: "0.1.0", logsDir: temp(), tmpDir: temp(), env: [:]),
                              ask: { _ in 0 }, requestQuit: { _ in true }, makeChecker: { _ in FakeChecker("0.2.0") },
                              spawn: { f, a, e, l in FakeCommand(f, a, e, l) }, setTimer: { _, _ in }, setRepeat: { _, _ in 1 }, clearRepeat: { _ in }, hub: hub)
        let banner = UpdateBannerModel(updates: updates, hub: hub)
        XCTAssertNil(banner.content, "idle: nothing")
        await updates.check()
        await tick()
        XCTAssertEqual(banner.content?.text, "Downloading Engelbart 0.2.0…", "the install command started: every banner shows it")
    }

    func testStartAndConfirmAll() async {
        var timers: [TimeInterval] = []
        var every: [TimeInterval] = []
        let updates = Updates(options: Updates.Options(info: ReleaseInfo(downloads: Self.DOWNLOADS, developerId: false), packaged: true, currentVersion: "0.1.0", env: ["ENGELBART_CONFIRM_ALL": "1"]),
                              ask: { _ in XCTFail("answered by ENGELBART_CONFIRM_ALL"); return 1 }, requestQuit: { _ in true }, makeChecker: { _ in FakeChecker(nil) },
                              setTimer: { t, _ in timers.append(t) }, setRepeat: { t, _ in every.append(t); return 1 }, clearRepeat: { _ in })
        XCTAssertTrue(updates.start())
        XCTAssertEqual(timers, [60])
        XCTAssertEqual(every, [6 * 60 * 60])
        await updates.check(manual: true)
    }

    func testLastPercentAndLastLines() {
        let log = "\(temp())/update.log"
        XCTAssertNil(lastPercent(log))
        write(log, String(repeating: "x", count: 5000) + "\r##   7,5%\r###   99.9%")
        XCTAssertEqual(lastPercent(log), 99.9)
        write(log, "500% nonsense")
        XCTAssertNil(lastPercent(log))
        write(log, "a\r\nb\n########## 100%\n\nc\nd\n")
        XCTAssertEqual(updateLogLastLines(log), "b\nc\nd")
    }

    func testTheFeedCheckerReadsLatestMacYml() async throws {
        var asked: URL?
        let checker = FeedChecker(downloads: Self.DOWNLOADS, current: "0.1.25", fetch: { url in asked = url; return "version: 0.1.26\nfiles:\n  - url: Engelbart.zip\n" })
        var seen: String?
        checker.onAvailable = { seen = $0 }
        let newer = try await checker.checkForUpdates()
        XCTAssertEqual(asked?.absoluteString, "https://example.com/engelbart/latest-mac.yml")
        XCTAssertEqual([newer, seen], ["0.1.26", "0.1.26"])
        let same = FeedChecker(downloads: Self.DOWNLOADS, current: "0.1.26", fetch: { _ in "version: '0.1.26'\n" })
        let none = try await same.checkForUpdates()
        XCTAssertNil(none)
        let broken = FeedChecker(downloads: Self.DOWNLOADS, current: "0.1.26", fetch: { _ in "<html>" })
        do { _ = try await broken.checkForUpdates(); XCTFail("no version") } catch {}
    }

    func testTheRealSpawnRunsDetachedAndReportsItsExit() async {
        let log = "\(temp())/update.log"
        let exited = Once<Int32?>()
        let command = try! spawnDetached("/bin/sh", ["-c", "echo $ENGELBART_X; exit 4"], ["ENGELBART_X": "hello", "PATH": "/usr/bin:/bin"], log)
        command.onExit = { exited.resolve($0) }
        let code = await exited.wait()
        XCTAssertEqual(code, 4)
        XCTAssertEqual(try? String(contentsOfFile: log, encoding: .utf8), "hello\n")
    }
}
