import Darwin
import XCTest
@testable import EngelbartTerminal

// The agent-terminal part of test/browser-agents.test.cjs, plus a real PTY run.

final class AgentTerminalTests: XCTestCase {
    final class Spawned {
        var file = "", args: [String] = [], env: [String: String] = [:], cwd = ""
        var handle: FakeProcess!
        var queue: DispatchQueue!
    }

    /// A fake pty whose `script` runs once the run has wired its handlers.
    func fakeSpawn(_ script: @escaping (FakeProcess, DispatchQueue) -> Void) -> (AgentTerminal.Spawn, Spawned) {
        let record = Spawned()
        let spawn: AgentTerminal.Spawn = { file, args, env, cwd, _, _, queue in
            let handle = FakeProcess()
            record.file = file; record.args = args; record.env = env; record.cwd = cwd; record.handle = handle; record.queue = queue
            queue.async { script(handle, queue) }
            return handle
        }
        return (spawn, record)
    }

    func testPlainAndAnswers() {
        XCTAssertEqual(AgentTerminal.plain("\u{1b}[1mbold\u{1b}[0m\r\n\u{1b}]0;title\u{07}next\rline"), "bold\nnext\nline")
        XCTAssertEqual(AgentTerminal.answersFor("\u{1b}[c\u{1b}[>q"), ["\u{1b}[?62;22c", "\u{1b}P>|xterm.js(6.0.0)\u{1b}\\"])
        XCTAssertEqual(AgentTerminal.answersFor("\u{1b}]11;?\u{07}\u{1b}[6n\u{1b}[?996n"),
                       ["\u{1b}]11;rgb:ffff/ffff/ffff\u{1b}\\", "\u{1b}[1;1R", "\u{1b}[?997;2n"])
        XCTAssertEqual(AgentTerminal.answersFor("\u{1b}[>0c\u{1b}[?u\u{1b}[14t\u{1b}[16t\u{1b}]10;?\u{1b}\\"),
                       ["\u{1b}[>0;276;0c", "\u{1b}[?0u", "\u{1b}[4;800;1600t", "\u{1b}[6;16;8t", "\u{1b}]10;rgb:1717/1717/1717\u{1b}\\"])
        XCTAssertEqual(AgentTerminal.plain("\u{1b}P1$r\u{1b}\\a\u{1b}_x\u{1b}\\b\u{1b}(Bc\u{1b}=d\u{1b}7e"), "abcde")
    }

    func testALoginShellTheTerminalsQuestionsAnsweredLinesWithoutEscapeCodes() async {
        let (spawn, spawned) = fakeSpawn { handle, _ in
            handle.print("\u{1b}[c{\"type\":\"a\"}\r\n{\"type\":")
            handle.print("\"b\"}\r\npartial")
            handle.onExit?(0, nil)
        }
        let terminal = AgentTerminal(environment: ["SHELL": "/bin/zsh", "PATH": "/usr/bin", "HOME": "/tmp"], spawn: spawn)
        let lines = Lines()
        let out = await terminal.run(.init(command: "exec claude -p", env: ["SHELL": "/bin/zsh", "PATH": "/usr/bin", "HOME": "/tmp", "SECRET": "kept-as-given"],
                                           cwd: "/tmp", onLine: { lines.add($0) }))
        XCTAssertEqual(lines.all, [#"{"type":"a"}"#, #"{"type":"b"}"#, "partial"])
        XCTAssertEqual(out.exitCode, 0)
        XCTAssertEqual(out.output, "{\"type\":\"a\"}\n{\"type\":\"b\"}\npartial")
        XCTAssertEqual(spawned.file, "/bin/zsh")
        XCTAssertTrue(spawned.args.contains("exec claude -p"), "\(spawned.args)")
        XCTAssertEqual(spawned.env["TERM"], "xterm-256color")
        XCTAssertEqual(spawned.env["TERMINAL_USER_SHELL"], "/bin/zsh")
        XCTAssertEqual(spawned.env["SECRET"], "kept-as-given", "the caller's environment is the whole of it")
        XCTAssertEqual(spawned.handle.written, ["\u{1b}[?62;22c"], "the terminal question answered as xterm.js answers it")
    }

    func testStopEndsIt() async {
        let (spawn, spawned) = fakeSpawn { _, _ in }
        let stop = StopSignal()
        let terminal = AgentTerminal(environment: ["SHELL": "/bin/zsh"], spawn: spawn)
        async let pending = terminal.run(.init(command: "sleep 99", cwd: "/tmp", stop: stop))
        try? await Task.sleep(nanoseconds: 50_000_000)
        stop.stop()
        try? await Task.sleep(nanoseconds: 50_000_000)
        spawned.queue.sync {}
        XCTAssertEqual(spawned.handle.killed, [SIGTERM])
        spawned.queue.async { spawned.handle.onExit?(0, SIGTERM) }
        let stopped = await pending
        XCTAssertTrue(stopped.stopped)
        XCTAssertFalse(stopped.timedOut)
        XCTAssertEqual(stopped.signal, SIGTERM)
    }

    func testAlreadyStoppedKillsOnTheNextTickAndATimeoutKillsToo() async {
        let (spawn, spawned) = fakeSpawn { handle, queue in queue.asyncAfter(deadline: .now() + 0.2) { handle.onExit?(0, SIGTERM) } }
        let stop = StopSignal()
        stop.stop()
        let out = await AgentTerminal(environment: ["SHELL": "/bin/zsh"], spawn: spawn).run(.init(command: "x", cwd: "/tmp", stop: stop))
        XCTAssertTrue(out.stopped)
        XCTAssertEqual(spawned.handle.killed.first, SIGTERM)

        let (spawn2, spawned2) = fakeSpawn { handle, queue in queue.asyncAfter(deadline: .now() + 0.3) { handle.onExit?(0, SIGTERM) } }
        let timed = await AgentTerminal(environment: ["SHELL": "/bin/zsh"], spawn: spawn2).run(.init(command: "x", cwd: "/tmp", timeout: 0.05))
        XCTAssertTrue(timed.timedOut)
        XCTAssertFalse(timed.stopped)
        XCTAssertEqual(spawned2.handle.killed.first, SIGTERM)
    }

    func testASpawnFailureIs127() async {
        let failing: AgentTerminal.Spawn = { _, _, _, _, _, _, _ in throw TerminalError("forkpty(3) failed.") }
        let out = await AgentTerminal(environment: ["SHELL": "/bin/zsh"], spawn: failing).run(.init(command: "x", cwd: "/tmp"))
        XCTAssertEqual(out, AgentTerminal.Result(output: "", exitCode: 127, signal: nil, timedOut: false, stopped: false, error: "forkpty(3) failed."))
    }

    func testTheTerminalsOwnEnvironmentWhenNoneIsGiven() async {
        let (spawn, spawned) = fakeSpawn { handle, _ in handle.onExit?(0, nil) }
        let terminal = AgentTerminal(environment: ["SHELL": "/bin/zsh", "CLAUDECODE": "1", "HOME": "/tmp"], extraEnvironment: { ["ENGELBART_AGENT_PATH": "/agents"] }, spawn: spawn)
        _ = await terminal.run(.init(command: "codex exec hi", cwd: "/tmp"))
        XCTAssertNil(spawned.env["CLAUDECODE"], "sanitized")
        XCTAssertEqual(spawned.env["ENGELBART_AGENT_PATH"], "/agents")
        XCTAssertEqual(spawned.args, ["-ilc", #"PATH="$PATH:$ENGELBART_AGENT_PATH"; codex exec hi"#])
        XCTAssertEqual(spawned.env["TERM_PROGRAM"], "Engelbart")
    }

    func testARealPtyRunAnswersAndKeepsTheOutput() async throws {
        let home = temporaryDirectory(self)
        let terminal = AgentTerminal(environment: ["SHELL": "/bin/zsh", "HOME": home, "PATH": "/usr/bin:/bin", "ZDOTDIR": home])
        let lines = Lines()
        // Ask DA1 and read the reply from the terminal, as a full-screen CLI does.
        let out = await terminal.run(.init(command: #"stty -echo; printf '\033[c'; IFS= read -r -t 3 -d c reply; print -r -- "got:${reply//[^0-9;?]/}"; exit 3"#,
                                           cwd: home, timeout: 10, onLine: { lines.add($0) }))
        XCTAssertEqual(out.exitCode, 3, out.output)
        XCTAssertTrue(out.output.contains("got:?62;22"), out.output)
        XCTAssertTrue(lines.all.contains { $0.contains("got:?62;22") })
    }
}

final class Lines: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    func add(_ line: String) { lock.lock(); lines.append(line); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return lines }
}
