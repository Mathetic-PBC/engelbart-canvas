import AppKit
import EngelbartCore
import XCTest
@testable import EngelbartTerminal

/// The pane end to end, as a person would drive it: a real zsh through the launcher and wrappers, the box, the marks,
/// the tabs, the menu, the keys. The window is offscreen; keys go through the pane's own key handling.
@MainActor
final class PaneTests: XCTestCase {
    final class Host: TerminalHost {
        var terminalProjectId: String? = "project-1"
        var terminalProjectDirectory: String?
        var opened: [String] = []
        var picked: String?
        var docKeys = false
        var full: Bool? = false
        var toggled = 0
        var touched: [String] = []
        func terminalOpenLink(_ url: String) { opened.append(url) }
        func terminalPickDirectory(current: String?, window: NSWindow?, completion: @escaping (String?) -> Void) { completion(picked) }
        func terminalPdfText(_ text: String) -> String { text.replacingOccurrences(of: "-\n", with: "") }
        func terminalKeysToDoc() -> Bool { docKeys }
        var terminalFullScreen: Bool? { full }
        func terminalToggleFullScreen() { toggled += 1 }
        func terminalTouchSandbox(libraryId: String) { touched.append(libraryId) }
    }

    var window: NSWindow!
    var home = ""
    var project = ""
    var store: TerminalSessions!
    var host: Host!
    var pane: TerminalPaneController!

    override func setUp() async throws {
        _ = NSApplication.shared
        home = temporaryDirectory(self)
        project = temporaryDirectory(self, prefix: "project-")
        // A person's own startup files, with a `claude` that stands in for Claude Code (never the real one).
        write("claude() { print -r -- CLAUDE_STANDIN_RUNNING; sleep 2 }\nPROMPT='mine> '\n", to: home + "/.zshrc")
        var configuration = TerminalSessions.Configuration()
        configuration.environment = ["HOME": home, "SHELL": "/bin/zsh", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8", "TERM": "dumb"]
        configuration.userData = URL(fileURLWithPath: temporaryDirectory(self, prefix: "userdata-"))
        configuration.home = home
        configuration.providers = { shell, done in
            done(.success([TerminalProviderInfo(id: "shell", name: "Shell", available: true, path: shell),
                           TerminalProviderInfo(id: "claude", name: "Claude Code", available: true),
                           TerminalProviderInfo(id: "codex", name: "Codex", available: false)]))
        }
        store = TerminalSessions(configuration: configuration)
        host = Host()
        host.terminalProjectDirectory = project
        pane = TerminalPaneController(store: store, host: host)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
        pane.view.frame = window.contentView!.bounds
        pane.view.autoresizingMask = [.width, .height]
        window.contentView!.addSubview(pane.view)
        pane.viewDidAppear()
        window.layoutIfNeeded()
    }

    override func tearDown() async throws {
        pane?.viewWillDisappear()
        let done = XCTestExpectation(description: "shutdown")
        store?.manager.shutdown { done.fulfill() }
        await fulfillment(of: [done], timeout: 5)
        window?.close()
    }

    func waitUntil(_ timeout: TimeInterval = 8, _ message: String = "", _ predicate: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !predicate() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
        XCTAssertTrue(predicate(), "timed out: \(message)")
    }

    func key(_ chars: String, code: UInt16, _ flags: NSEvent.ModifierFlags = []) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: window.windowNumber, context: nil,
                         characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
    }

    func typeInBox(_ text: String) {
        pane.focusBox()
        pane.setDraft(text)
        XCTAssertTrue(pane.boxKey(key("\r", code: 36)))
    }

    func transcript(_ record: TerminalRecord) -> String {
        record.view.getBufferAsData().map { String(decoding: [$0], as: UTF8.self) }.joined()
    }

    func idleShell() -> TerminalRecord {
        waitUntil(10, "a shell auto-started and reported ready") { pane.current?.shell.integrated == true && pane.current?.shell.busy == false }
        return pane.current!
    }

    func testAShellStartsInTheProjectDirectoryWithTheBoxAsTheInput() {
        let record = idleShell()
        XCTAssertEqual(record.snapshot.cwd, project)
        XCTAssertEqual(record.projectId, "project-1")
        XCTAssertEqual(pane.strip.tabs.map(\.model.title), [(project as NSString).lastPathComponent])
        XCTAssertEqual(pane.strip.tabs.first?.model.closeTooltip, "Clear — the last terminal stays")
        XCTAssertEqual(pane.footer.agentLabel, "Terminal")
        XCTAssertEqual(pane.footer.cwd, project)
        XCTAssertEqual(pane.footer.bottom, .box)
        XCTAssertTrue(pane.boxIsInput)
        XCTAssertTrue(record.view.locked, "the transcript is inert while the box is the input")
        XCTAssertEqual(record.view.superview, pane.stage)
        XCTAssertEqual(record.view.frame.origin, NSPoint(x: 14, y: 10))
        XCTAssertFalse(transcript(record).contains("mine>"), "no prompt in the transcript")
        XCTAssertEqual(store.settingsStore.get().lastCwd, project, "the last directory is remembered")
    }

    func testTheBoxSendsALineAndKeepsHistory() {
        let record = idleShell()
        typeInBox("echo BOX_$((40+2))")
        waitUntil(5, "output") { transcript(record).contains("BOX_42") }
        XCTAssertEqual(pane.history.last, "echo BOX_$((40+2))")
        XCTAssertTrue(pane.touched.contains(record.id))
        XCTAssertEqual(pane.draft, "")
        // ↑ recalls it, ↓ past the end empties the box.
        XCTAssertTrue(pane.boxKey(key("", code: 126)))
        XCTAssertEqual(pane.draft, "echo BOX_$((40+2))")
        XCTAssertTrue(pane.boxKey(key("", code: 125)))
        XCTAssertEqual(pane.draft, "")
        XCTAssertNil(pane.histIdx)
        // Tab and Shift+Enter do nothing; Ctrl+C empties the box.
        pane.setDraft("partial")
        XCTAssertTrue(pane.boxKey(key("\t", code: 48)))
        XCTAssertTrue(pane.boxKey(key("\r", code: 36, .shift)))
        XCTAssertEqual(pane.draft, "partial")
        XCTAssertTrue(pane.boxKey(key("c", code: 8, .control)))
        XCTAssertEqual(pane.draft, "")
        XCTAssertEqual(pane.footer.cwd, project)
    }

    func testTheShellHistoryFileSeedsTheBox() throws {
        write(": 1:0;from-the-file\n", to: home + "/.zsh_history")
        let fresh = TerminalPaneController(store: store, host: host)
        _ = fresh.view
        XCTAssertEqual(fresh.history.last, "from-the-file")
    }

    func testARunningCommandTakesTheKeyboardAfter200msAndGivesItBack() {
        let record = idleShell()
        typeInBox("sleep 1")
        waitUntil(5, "busy") { record.shell.busy }
        XCTAssertEqual(record.shell.command, "sleep 1")
        XCTAssertFalse(pane.takeover, "not at once")
        waitUntil(2, "takeover") { pane.takeover }
        XCTAssertEqual(pane.footer.bottom, .line("\u{a0}"), "a blank line keeps the box's place")
        XCTAssertFalse(record.view.locked)
        waitUntil(5, "idle again") { !record.shell.busy && !pane.takeover }
        XCTAssertEqual(pane.footer.bottom, .box)
        XCTAssertTrue(record.view.locked)
    }

    func testCdInTheShellMovesTheDirectoryChip() throws {
        let record = idleShell()
        let sub = project + "/sub dir"
        try FileManager.default.createDirectory(atPath: sub, withIntermediateDirectories: true)
        typeInBox("cd 'sub dir'")
        waitUntil(5, "chip follows cd") { pane.footer.cwd == sub }
        XCTAssertEqual(pane.strip.tabs.first?.model.title, "sub dir")
        XCTAssertEqual(record.description.cwd, sub)
    }

    func testTheCwdChipChangesAnIdleShellsDirectory() throws {
        _ = idleShell()
        let other = temporaryDirectory(self, prefix: "other-")
        host.picked = other
        pane.changeCwd()
        waitUntil(5, "cd from the chip") { pane.footer.cwd == other }
    }

    func testCmdTOpensATabCmdWClosesItAndCmd1Switches() {
        let first = idleShell()
        pane.focusBox()
        XCTAssertTrue(pane.handleKey(key("t", code: 17, .command)))
        waitUntil(5, "two tabs") { pane.mySessions.count == 2 }
        let second = pane.current!
        XCTAssertNotEqual(second.id, first.id)
        XCTAssertEqual(second.snapshot.cwd, project, "⌘T opens in the project's directory")
        XCTAssertEqual(pane.strip.tabs.first?.model.closeTooltip, "Close")
        waitUntil(5, "focus in the box") { pane.boxHasKeys }
        XCTAssertTrue(pane.handleKey(key("1", code: 18, .command)))
        XCTAssertEqual(pane.current?.id, first.id)
        XCTAssertFalse(pane.handleKey(key("9", code: 25, .command)), "no ninth tab: the key passes")
        XCTAssertFalse(pane.handleKey(key("1", code: 18, .control)), "Ctrl+digits pass through")
        XCTAssertTrue(pane.handleKey(key("w", code: 13, .command)))
        waitUntil(5, "one tab") { pane.mySessions.count == 1 }
        XCTAssertEqual(pane.current?.id, second.id, "the next tab at the same place comes forward")
        // The middle canvas clicked last and the keyboard elsewhere: ⌘T is the document's.
        host.docKeys = true
        window.makeFirstResponder(nil)
        XCTAssertFalse(pane.handleKey(key("t", code: 17, .command)))
        XCTAssertFalse(pane.handleKey(key("w", code: 13, .command)), "⌘W only from inside the pane")
    }

    func testTheLastTabsCloseClearsAnIdleShellAndReplacesABusyOne() {
        let record = idleShell()
        typeInBox("echo CLEAR_ME")
        waitUntil(5) { transcript(record).contains("CLEAR_ME") }
        pane.close(record.id)
        XCTAssertEqual(pane.mySessions.map(\.id), [record.id], "the last terminal stays")
        waitUntil(2, "cleared") { !transcript(record).contains("CLEAR_ME") }
        typeInBox("sleep 5")
        waitUntil(5) { record.shell.busy }
        pane.close(record.id)
        waitUntil(5, "a fresh shell replaced it") { pane.mySessions.count == 1 && pane.mySessions[0].id != record.id }
        XCTAssertNil(store.record(record.id))
    }

    func testTheAgentMenuTurnsAnUntouchedIdleTerminalIntoTheAgentInPlace() {
        let record = idleShell()
        XCTAssertEqual(store.providers["codex"]?.available, false)
        pane.pickAgent("claude")
        waitUntil(5, "claude typed in place") { record.shell.busy && record.shell.command == "claude" }
        XCTAssertEqual(pane.mySessions.count, 1)
        XCTAssertEqual(pane.now.agent, "claude")
        XCTAssertTrue(pane.takeover, "an agent takes the keyboard at once")
        XCTAssertEqual(pane.footer.bottom, .none, "a conversation keeps no room for a box")
        XCTAssertEqual(pane.footer.agentLabel, "Claude Code")
        XCTAssertEqual(pane.strip.agentLabel, "Claude Code")
        waitUntil(6, "back to the box") { !record.shell.busy && pane.footer.bottom == .box }
        // A used terminal keeps its transcript: the agent gets a tab of its own.
        typeInBox("true")
        waitUntil(5) { pane.touched.contains(record.id) && !record.shell.busy }
        pane.pickAgent("codex")
        XCTAssertEqual(pane.mySessions.count, 1, "an agent that is not installed starts nothing")
        pane.pickAgent("shell")
        XCTAssertEqual(pane.mySessions.count, 1, "Terminal while a terminal is in front: it only takes the keys")
        // Claude Code in a used tab: a tab of its own, at the same directory; picked again, that tab comes forward.
        pane.pickAgent("claude")
        waitUntil(5, "a Claude Code tab") { pane.mySessions.count == 2 }
        let agentTab = pane.current!
        XCTAssertEqual(agentTab.snapshot.provider, .claude)
        XCTAssertEqual(agentTab.snapshot.cwd, project)
        XCTAssertEqual(pane.now.agent, "claude")
        pane.activate(record.id)
        pane.pickAgent("claude")
        XCTAssertEqual(pane.current?.id, agentTab.id)
        XCTAssertEqual(pane.mySessions.count, 2)
        // Terminal from there: the newest other idle shell comes forward.
        pane.pickAgent("shell")
        XCTAssertEqual(pane.current?.id, record.id)
    }

    func testAProjectDirectoryChangeMovesUntouchedTerminals() throws {
        _ = idleShell()
        let moved = temporaryDirectory(self, prefix: "moved-")
        host.terminalProjectDirectory = moved
        pane.projectDidChange()
        waitUntil(5, "followed") { pane.footer.cwd == moved }
    }

    func testLinksGoToTheStageAndOthersAreRefused() {
        let record = idleShell()
        store.openLink("http://localhost:5173", from: record.id)
        XCTAssertEqual(host.opened, ["http://localhost:5173/"])
        store.openLink("file:///etc/passwd", from: record.id)
        XCTAssertEqual(store.errors.last?.message, "Link could not be opened: URL protocol must be http or https")
        XCTAssertEqual(pane.stage.subviews.compactMap { $0 as? MessageLine }.count, 1, "the error shows in the stage")
        store.dismissError(at: store.errors.last!.at)
        XCTAssertTrue(store.errors.isEmpty)
    }

    func testALockedTranscriptHandsPressesAndKeysToTheBox() {
        let record = idleShell()
        window.makeFirstResponder(record.view)
        waitUntil(2, "the box takes the keys back") { pane.boxHasKeys }
        // A key that reaches the locked transcript goes into the box.
        window.makeFirstResponder(record.view)
        XCTAssertTrue(pane.handleKey(key("x", code: 7)))
        XCTAssertEqual(pane.draft, "x")
        // A press on blank space starts nothing.
        let blank = record.view.convert(NSPoint(x: record.view.bounds.width - 5, y: 5), to: nil)
        let press = NSEvent.mouseEvent(with: .leftMouseDown, location: blank, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
                                       context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        XCTAssertFalse(record.view.textUnder(record.view.convert(blank, from: nil)))
        record.view.mouseDown(with: press)
        XCTAssertTrue(pane.boxHasKeys)
    }

    func testPastedPdfTextGoesThroughTheHost() {
        let record = idleShell()
        XCTAssertEqual(record.view.pasteTransform?("abil-\nities"), "abilities")
    }

    func testFullScreenButtonAndQuitCount() {
        _ = idleShell()
        XCTAssertTrue(pane.strip.showsFull)
        pane.strip.fullButton.action?()
        XCTAssertEqual(host.toggled, 1)
        host.full = nil
        pane.projectDidChange()
        XCTAssertFalse(pane.strip.showsFull)
        XCTAssertEqual(store.runningCount, 1)
    }

    func testABuildsTerminalIsAdoptedAndShown() throws {
        _ = idleShell()
        let snapshot = try store.manager.openCommand(cwd: project, command: "echo RUN_STEP_OK")
        let record = store.adopt(snapshot, projectId: "project-1")
        pane.show(sessionId: snapshot.id)
        XCTAssertEqual(pane.current?.id, snapshot.id)
        waitUntil(6, "the command ran") { transcript(record).contains("RUN_STEP_OK") }
        EventHub.shared.post("engelbart:show-terminal", .object(["id": .string(pane.mySessions[0].id)]))
        waitUntil(2) { pane.current?.id == pane.mySessions[0].id }
        store.drop(snapshot.id)
        XCTAssertEqual(pane.mySessions.count, 1)
    }

    func testHidingThePaneDetachesTheViewAndKeepsTheSession() {
        let record = idleShell()
        pane.visible = false
        XCTAssertNil(record.view.superview)
        XCTAssertTrue(record.isRunning)
        pane.visible = true
        XCTAssertEqual(record.view.superview, pane.stage)
    }

    func testTheCursorShowsOnlyWhileTheTranscriptHasTheKeys() {
        let record = idleShell()
        waitUntil(2) { pane.boxHasKeys }
        XCTAssertEqual(record.view.caretColor.alphaComponent, 0, "no cursor while the box is the input")
        typeInBox("sleep 2")
        waitUntil(3, "takeover gives the transcript the keys") { pane.takeover && window.firstResponder === record.view }
        waitUntil(1) { record.view.caretColor.alphaComponent > 0 }
        XCTAssertEqual(record.view.caretColor, TerminalTheme.cursor)
    }

    func testOptionScrollsTenTimesFaster() {
        let record = idleShell()
        XCTAssertEqual(record.view.scrollSensitivity, 2.5)
        pane.scrollWillHappen(option: true, in: window)
        XCTAssertEqual(record.view.scrollSensitivity, 10)
        pane.scrollWillHappen(option: false, in: window)
        XCTAssertEqual(record.view.scrollSensitivity, 2.5)
        pane.scrollWillHappen(option: true, in: nil)
        XCTAssertEqual(record.view.scrollSensitivity, 2.5, "another window's scroll leaves it alone")
    }

    func testARightClickSelectsTheWordUnderThePointer() {
        let record = idleShell()
        typeInBox("sleep 3")
        waitUntil(3) { pane.takeover }
        record.view.feed(text: "\u{1b}[H\u{1b}[2Jhello world")
        let dims = record.view.terminalDimensions
        let grid = record.view.getOptimalFrameSize()
        let cell = NSSize(width: grid.width / CGFloat(dims.cols), height: grid.height / CGFloat(dims.rows))
        let point = NSPoint(x: cell.width * 8.5, y: record.view.bounds.height - cell.height * 0.5) // "world", row 0
        XCTAssertTrue(record.view.textUnder(point))
        XCTAssertFalse(record.view.textUnder(NSPoint(x: cell.width * 40, y: point.y)), "blank space past the text")
        let location = record.view.convert(point, to: nil)
        let event = NSEvent.mouseEvent(with: .rightMouseDown, location: location, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
                                       context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        record.view.rightMouseDown(with: event)
        XCTAssertEqual(store.selectionText(record.id), "world")
    }

    func testTheAgentMenuOpensAndCloses() {
        _ = idleShell()
        pane.toggleMenu()
        XCTAssertTrue(pane.agentMenu.isOpen)
        XCTAssertTrue(pane.strip.menuOpen)
        pane.toggleMenu()
        XCTAssertFalse(pane.agentMenu.isOpen)
        XCTAssertFalse(pane.strip.menuOpen)
    }

    /// TERMINAL_SNAPSHOT_DIR=<dir>: the strip and the footer drawn to PNGs (idle; two tabs, one running; a conversation)
    /// for a look at the layout. (The transcript draws through SwiftTerm's render loop, which an offscreen cache misses.)
    func testSnapshotsForALook() throws {
        guard let dir = ProcessInfo.processInfo.environment["TERMINAL_SNAPSHOT_DIR"] else { throw XCTSkip("set TERMINAL_SNAPSHOT_DIR") }
        func shot(_ name: String) {
            pane.view.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.3))
            for (part, view) in [("strip", pane.strip as NSView), ("footer", pane.footer as NSView)] {
                guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { continue }
                view.cacheDisplay(in: view.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(dir)/\(name)-\(part).png"))
            }
        }
        let record = idleShell()
        typeInBox("echo hi")
        waitUntil(5) { transcript(record).contains("hi") }
        pane.setDraft("ls -la")
        shot("1-idle")
        XCTAssertTrue(pane.handleKey(key("t", code: 17, .command)))
        waitUntil(5) { pane.mySessions.count == 2 }
        typeInBox("sleep 3")
        waitUntil(5) { pane.takeover }
        shot("2-two-tabs-running")
        pane.pickAgent("claude")
        waitUntil(5) { pane.footer.bottom == .none }
        shot("3-conversation")
    }
}
