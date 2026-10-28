import XCTest
@testable import EngelbartTerminal

// test/renderer-helpers.test.cjs, plus the OSC 633 marks and describe() of TerminalPane.jsx.

final class HelpersTests: XCTestCase {
    func testSplitUtf8ChunksPreservesOrderedUnicodeBelowTheByteCeiling() throws {
        let source = String(repeating: "a", count: 11) + "🧠" + String(repeating: "漢字", count: 20) + "\n" + String(repeating: "🧪", count: 9)
        let chunks = try TerminalHelpers.splitUtf8Chunks(source, maximumBytes: 17)
        XCTAssertEqual(chunks.joined(), source)
        XCTAssertGreaterThan(chunks.count, 1)
        XCTAssertTrue(chunks.allSatisfy { $0.utf8.count <= 17 })
        XCTAssertTrue(chunks.allSatisfy { !$0.contains("\u{fffd}") })
        XCTAssertEqual(try TerminalHelpers.splitUtf8Chunks(""), [])
    }

    func testSplitUtf8ChunksRejectsALimitTooSmallForOneUnicodeScalar() {
        XCTAssertThrowsError(try TerminalHelpers.splitUtf8Chunks("🧠", maximumBytes: 3)) {
            XCTAssertEqual(($0 as? TerminalError)?.message, "Chunk limit cannot contain one complete character")
        }
    }

    func testTerminalKeyMappingReservesOnlyPlainShiftEnterAndMacOSCopy() {
        typealias K = TerminalHelpers.Key
        XCTAssertEqual(TerminalHelpers.terminalKeyAction(K(key: "Enter", shift: true)), .lineFeed)
        XCTAssertNil(TerminalHelpers.terminalKeyAction(K(key: "Enter", shift: true, composing: true)))
        XCTAssertNil(TerminalHelpers.terminalKeyAction(K(key: "Enter", shift: true, alt: true)))
        XCTAssertNil(TerminalHelpers.terminalKeyAction(K(key: "j", ctrl: true)))
        XCTAssertNil(TerminalHelpers.terminalKeyAction(K(key: "Enter", alt: true)))
        XCTAssertEqual(TerminalHelpers.terminalKeyAction(K(key: "c", meta: true)), .copy)
        XCTAssertNil(TerminalHelpers.terminalKeyAction(K(key: "c", ctrl: true)))
    }

    func testWorkspaceShortcutsRecognizeLiteralCmdPlusWithoutStealingEqualsOrCtrlCombos() {
        typealias K = TerminalHelpers.Key
        XCTAssertEqual(TerminalHelpers.workspaceKeyAction(K(key: "+", meta: true)), .fontIncrease)
        XCTAssertNil(TerminalHelpers.workspaceKeyAction(K(key: "=", meta: true)))
        XCTAssertNil(TerminalHelpers.workspaceKeyAction(K(key: "+", ctrl: true, meta: true)))
        XCTAssertNil(TerminalHelpers.workspaceKeyAction(K(key: "+", ctrl: true)))
    }

    func testWorkspaceShortcutsAreInertBehindTheNewSessionModal() {
        typealias K = TerminalHelpers.Key
        XCTAssertNil(TerminalHelpers.workspaceKeyAction(K(key: "Escape"), dialogOpen: true, findOpen: true))
        XCTAssertNil(TerminalHelpers.workspaceKeyAction(K(key: "2", meta: true), dialogOpen: true, findOpen: true))
        XCTAssertNil(TerminalHelpers.workspaceKeyAction(K(key: "+", meta: true), dialogOpen: true, findOpen: true))
        XCTAssertEqual(TerminalHelpers.workspaceKeyAction(K(key: "2", meta: true)), .activateSession(1))
        XCTAssertEqual(TerminalHelpers.workspaceKeyAction(K(key: "Escape"), findOpen: true), .closeFind)
    }

    func testCrossSourceShortcutGateSuppressesOneMenuEchoWithoutBlockingLaterPresses() {
        let gate = CrossSourceShortcutGate(windowMs: 100)
        XCTAssertTrue(gate.allow("font-increase", source: "renderer", now: 1000))
        XCTAssertFalse(gate.allow("font-increase", source: "menu", now: 1005))
        XCTAssertTrue(gate.allow("font-increase", source: "renderer", now: 1040))
        let reverse = CrossSourceShortcutGate(windowMs: 100)
        XCTAssertTrue(reverse.allow("font-increase", source: "menu", now: 2000))
        XCTAssertFalse(reverse.allow("font-increase", source: "renderer", now: 2002))
    }

    func testInitialTerminalGeometryPreservesValidatedNonDefaultSnapshotDimensions() throws {
        let geometry = try TerminalHelpers.initialTerminalGeometry(cols: 137, rows: 41)
        XCTAssertEqual(geometry.cols, 137); XCTAssertEqual(geometry.rows, 41)
        XCTAssertThrowsError(try TerminalHelpers.initialTerminalGeometry(cols: 0, rows: 41))
        XCTAssertThrowsError(try TerminalHelpers.initialTerminalGeometry(cols: 137, rows: 501))
    }

    func testChromeFocusIsPreservedOnlyForASurvivingSessionControlIdentity() {
        XCTAssertEqual(TerminalHelpers.preservedChromeFocus(sessionId: "one", action: "tab-close", sessionIds: ["one", "two"])?.action, "tab-close")
        XCTAssertNil(TerminalHelpers.preservedChromeFocus(sessionId: "gone", action: "tab", sessionIds: ["one"]))
        XCTAssertNil(TerminalHelpers.preservedChromeFocus(sessionId: "one", action: "terminal", sessionIds: ["one"]))
        XCTAssertNil(TerminalHelpers.preservedChromeFocus(sessionId: nil, action: nil, sessionIds: ["one"]))
    }

    func testATerminalLinkIsAWebPageForTheStageOrItIsRefused() {
        XCTAssertEqual(try TerminalHelpers.browserLink("http://localhost:5173"), "http://localhost:5173/")
        XCTAssertEqual(try TerminalHelpers.browserLink("https://example.com/a?b=1#c"), "https://example.com/a?b=1#c")
        XCTAssertEqual(try TerminalHelpers.browserLink("HTTPS://Example.com"), "https://example.com/")
        for (uri, message) in [("file:///tmp/private", "URL protocol must be http or https"), ("javascript:alert(1)", "URL protocol must be http or https"),
                               ("mailto:a@b.c", "URL protocol must be http or https"), ("not a url", "URL is invalid")] {
            XCTAssertThrowsError(try TerminalHelpers.browserLink(uri)) { XCTAssertEqual(($0 as? TerminalError)?.message, message, uri) }
        }
    }

    func testPendingEventsMergeBootstrapHistoryMonotonicallyExactlyOnce() {
        let pending = PendingEvents()
        pending.pushData(.init(id: "one", sequence: 3, data: "third"))
        pending.pushData(.init(id: "one", sequence: 2, data: "second-live"))
        pending.pushData(.init(id: "one", sequence: 3, data: "duplicate"))
        pending.pushExit(SessionExit(id: "one", exitCode: 7, signal: SIGTERM))
        let result = pending.take("one", history: [HistoryEntry(sequence: 1, data: "first"), HistoryEntry(sequence: 2, data: "second-snapshot")])
        XCTAssertEqual(result.data, [HistoryEntry(sequence: 1, data: "first"), HistoryEntry(sequence: 2, data: "second-live"), HistoryEntry(sequence: 3, data: "third")])
        XCTAssertEqual(result.exit, SessionExit(id: "one", exitCode: 7, signal: SIGTERM))
        XCTAssertEqual(pending.take("one").data, [])
    }

    func testPendingEventStorageIsBoundedAndReportsDataDroppedUnderOverflow() {
        let pending = PendingEvents(maxEntries: 2, maxBytes: 100)
        XCTAssertEqual(pending.pushData(.init(id: "a", sequence: 1, data: "a")), [])
        XCTAssertEqual(pending.pushData(.init(id: "b", sequence: 1, data: "b")), [])
        XCTAssertEqual(pending.pushData(.init(id: "a", sequence: 2, data: "c")), [.init(id: "a", sequence: 1, data: "a")])
        XCTAssertEqual(pending.take("a").data, [HistoryEntry(sequence: 2, data: "c")])
        XCTAssertEqual(pending.take("b").data, [HistoryEntry(sequence: 1, data: "b")])
    }

    func testEstimateDimensions() {
        XCTAssertEqual(TerminalHelpers.estimateDimensions(size: nil, fontSize: 14).cols, Int((776.0 / (14 * 0.61)).rounded(.down)))
        XCTAssertEqual(TerminalHelpers.estimateDimensions(size: nil, fontSize: 14).rows, Int((282.0 / (14 * 1.2)).rounded(.down)))
        XCTAssertEqual(TerminalHelpers.estimateDimensions(size: CGSize(width: 10, height: 10), fontSize: 14).cols, 20)
        XCTAssertEqual(TerminalHelpers.estimateDimensions(size: CGSize(width: 10, height: 10), fontSize: 14).rows, 5)
        XCTAssertEqual(TerminalHelpers.estimateDimensions(size: CGSize(width: 100_000, height: 100_000), fontSize: 14).cols, 500)
    }

    // OSC 633 (sessions.js applyShellMark) and describe() (TerminalPane.jsx)

    func testOscScannerFindsMarksAcrossChunksWithBelOrSt() {
        var scanner = OscScanner()
        let stream = Array("out\u{1b}]633;P;Cwd=/tmp/a b\u{07}\u{1b}]633;A\u{07}more\u{1b}]0;title\u{07}\u{1b}]633;E;ls -la\u{1b}\\\u{1b}]633;C\u{07}".utf8)
        var marks: [String] = []
        for split in stride(from: 0, to: stream.count, by: 3) { marks += scanner.scan(Array(stream[split..<min(split + 3, stream.count)])) }
        XCTAssertEqual(marks, ["P;Cwd=/tmp/a b", "A", "E;ls -la", "C"])
        XCTAssertEqual(scanner.scan(Array("\u{1b}]633;P;Cwd=/tmp/é\u{07}".utf8)), ["P;Cwd=/tmp/é"])
    }

    func testShellStateFollowsTheMarks() {
        var state = ShellState.initial(provider: .shell, cwd: "/start")
        XCTAssertEqual(state, ShellState(integrated: false, busy: false, command: "", cwd: "/start"))
        XCTAssertEqual(ShellState.initial(provider: .claude, cwd: "/x").busy, true)
        state.apply("P;Cwd=/tmp")
        XCTAssertEqual(state.cwd, "/tmp")
        state.apply("P;Cwd=")
        XCTAssertEqual(state.cwd, "/tmp", "an empty directory keeps the old one")
        state.apply("A")
        XCTAssertEqual(state, ShellState(integrated: true, busy: false, command: "", cwd: "/tmp"))
        state.apply("E;claude --resume")
        state.apply("C")
        XCTAssertEqual(state, ShellState(integrated: true, busy: true, command: "claude --resume", cwd: "/tmp"))
        XCTAssertFalse(state.apply("Z"))
        state.apply("E;")
        XCTAssertEqual(state.command, "")
    }

    func testDescribeTellsAnAgentByItsCommandLine() {
        XCTAssertEqual(TabDescription.agentOfCommand("claude"), "claude")
        XCTAssertEqual(TabDescription.agentOfCommand("  codex exec hi"), "codex")
        XCTAssertEqual(TabDescription.agentOfCommand("FOO=1 BAR=x sudo /usr/local/bin/claude -r"), "claude")
        XCTAssertEqual(TabDescription.agentOfCommand("exec noglob ~/.local/bin/codex"), "codex")
        XCTAssertNil(TabDescription.agentOfCommand("claudette"))
        XCTAssertNil(TabDescription.agentOfCommand("echo claude"))
        XCTAssertNil(TabDescription.agentOfCommand(""))
        let idle = TabDescription.of(provider: .shell, shell: ShellState(integrated: true, busy: false, command: "", cwd: "/a"))
        XCTAssertEqual(idle, TabDescription(integrated: true, busy: false, agent: "shell", command: "", cwd: "/a"))
        let typed = TabDescription.of(provider: .shell, shell: ShellState(integrated: true, busy: true, command: "claude", cwd: "/a"))
        XCTAssertEqual(typed.agent, "claude")
        XCTAssertEqual(TabDescription.of(provider: .shell, shell: ShellState(integrated: true, busy: true, command: "ls", cwd: "/a")).agent, "shell")
        let launched = TabDescription.of(provider: .codex, shell: .initial(provider: .codex, cwd: "/b"))
        XCTAssertEqual(launched, TabDescription(integrated: false, busy: true, agent: "codex", command: "", cwd: nil))
        XCTAssertEqual(TabDescription.of(provider: .shell, shell: .initial(provider: .shell, cwd: "/b")).busy, false)
    }

    func testUtf8BoundaryHelpers() {
        let e = Array("é".utf8) // 2 bytes
        XCTAssertEqual(UTF8Boundary.completePrefixLength([0x61] + [e[0]]), 1)
        XCTAssertEqual(UTF8Boundary.completePrefixLength([0x61] + e), 3)
        let brain = Array("🧠".utf8)
        XCTAssertEqual(UTF8Boundary.completePrefixLength(Array(brain[0..<3])), 0)
        XCTAssertEqual(UTF8Boundary.splitPrefix(Array("aé".utf8), max: 2).0, [0x61])
        XCTAssertEqual(UTF8Boundary.tail(Array("éa".utf8), max: 2), [0x61])
    }
}
