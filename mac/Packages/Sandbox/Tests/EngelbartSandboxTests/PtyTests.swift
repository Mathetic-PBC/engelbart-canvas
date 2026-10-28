import XCTest
import EngelbartCore
@testable import EngelbartSandbox

// test/sandbox-pty.test.cjs: a fake of the E2B pieces the pty uses, behaving as a live sandbox did (2026-10-03).
final class PtyTests: XCTestCase {
    final class Shells: @unchecked Sendable {
        let e2b = FakeE2B()
        let box = FakeSandbox("sb-1")
        let processes = Locked<[Int: (handle: FakeHandle, onData: @Sendable (Data) -> Void, exited: Bool)]>([:])
        let live = Locked<Set<String>>(["sb-1"])
        let failNext = Locked<SandboxError?>(nil)
        var nextPid = 100
        init() {
            e2b.connectHandler = { [unowned self] id, _ in
                if let e = failNext.with({ let e = $0; $0 = nil; return e }) { throw e }
                if !live.value.contains(id) { throw SandboxError("Sandbox \(id) not found", name: "NotFoundError", status: 404) }
                return box
            }
            box.ptyCreateHandler = { [unowned self] _, _, _, _, onData in
                let pid = nextPid; nextPid += 1
                let h = FakeHandle(pid: pid)
                processes.with { $0[pid] = (h, onData, false) }
                return h
            }
            box.ptyConnectHandler = { [unowned self] pid, onData in
                guard let p = processes.value[pid], !p.exited else { throw SandboxError("process \(pid) not found", name: "NotFoundError", status: 404) }
                let h = FakeHandle(pid: pid)
                processes.with { $0[pid] = (h, onData, false) }
                return h
            }
        }
        func print(_ pid: Int, _ bytes: Data) { processes.value[pid]?.onData(bytes) }
        func drop(_ pid: Int) { processes.value[pid]?.handle.drop() }
        func endWhileAsleep(_ pid: Int) { processes.with { $0[pid]?.exited = true } }
    }

    func plain(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{1b}\\[[0-9;]*[A-Za-z]", with: "", options: .regularExpression).replacingOccurrences(of: "\r", with: "")
    }

    func open(_ s: Shells, banner: String = "") -> (SandboxShell, Locked<String>, Locked<[SandboxShellExit]>) {
        let output = Locked(""), exits = Locked<[SandboxShellExit]>([])
        let shell = SandboxShell(e2b: s.e2b, sandboxId: "sb-1", options: SandboxShell.Options(cols: 80, rows: 24, cwd: "/home/user/repository/cli",
                                 env: ["API_TOKEN": "saved-secret", "TERM": "xterm-256color"], banner: banner, apiKey: { "e2b-key" }), idleMs: 600_000, requestTimeoutMs: 30_000)
        shell.onData { t in output.with { $0 += t } }
        shell.onExit { e in exits.with { $0.append(e) } }
        shell.begin()
        return (shell, output, exits)
    }

    func testSpawnConnectsCreatesStreamsAndExits() async throws {
        let s = Shells()
        let (shell, output, exits) = open(s, banner: "# Try: python main.py --help\r\n")
        await eventually { shell.pid == 100 }
        XCTAssertEqual(s.e2b.calls.value.first, "connect sb-1 600000")
        XCTAssertEqual(s.e2b.keys.value.first, "e2b-key")
        XCTAssertFalse(s.box.inputs.value.contains { $0.contains("saved-secret") }, "values are never typed into the shell")
        let bytes = Data("héllo ✓ 日本 🙂\r\nuser@e2b:~$ ".utf8)
        s.print(100, bytes.prefix(2)); s.print(100, bytes.subdata(in: 2..<7)); s.print(100, bytes.suffix(from: 7))
        XCTAssertEqual(plain(output.value), "Waking…# Try: python main.py --help\nhéllo ✓ 日本 🙂\nuser@e2b:~$ ")
        shell.write("ls\r"); shell.write("echo é\r"); shell.resize(cols: 132, rows: 40)
        await eventually { s.box.inputs.value.count == 2 }
        XCTAssertEqual(s.box.inputs.value, ["ls\r", "echo é\r"])
        await eventually { s.box.ptyCalls.value.contains("resize 100 132x40") }
        s.processes.value[100]!.handle.exit(3)
        await eventually { exits.value.count == 1 }
        XCTAssertEqual(exits.value, [SandboxShellExit(exitCode: 3)])
        shell.write("ignored")
        await settle()
        XCTAssertEqual(s.box.inputs.value.count, 2)
    }

    func testKillEndsTheShellNeverTheSandbox() async throws {
        let s = Shells()
        let (shell, _, exits) = open(s)
        await eventually { shell.pid == 100 }
        shell.kill()
        await eventually { exits.value.count == 1 }
        XCTAssertEqual(exits.value, [SandboxShellExit(exitCode: 0)])
        await eventually { s.box.ptyCalls.value.contains("kill 100") }
        await settle()
        XCTAssertEqual(exits.value.count, 1)
        XCTAssertTrue(s.live.value.contains("sb-1"))
    }

    func testAsleepSaysSoAndAKeystrokeTakesTheSameShellBack() async throws {
        let s = Shells()
        let (shell, output, exits) = open(s, banner: "# Try: make\r\n")
        await eventually { shell.pid == 100 }
        s.drop(100)
        await eventually { output.value.contains(SandboxPtyText.asleep) }
        XCTAssertEqual(exits.value, [])
        shell.resize(cols: 100, rows: 30)
        shell.write("\r"); shell.write("pwd\r")
        await eventually { s.box.inputs.value.count == 2 }
        XCTAssertEqual(s.box.inputs.value, ["\r", "pwd\r"])
        XCTAssertEqual(s.box.ptyCalls.value.filter { $0 == "create" || $0.hasPrefix("connect") }, ["create", "connect 100"])
        await eventually { s.box.ptyCalls.value.last == "resize 100 100x30" }
        XCTAssertEqual(plain(output.value).components(separatedBy: "# Try: make").count - 1, 1, "the hint only on first open")
    }

    func testReopenReplacesAnEndedShellAndAGoneSandboxEnds() async throws {
        let s = Shells()
        let (shell, output, exits) = open(s)
        await eventually { shell.pid == 100 }
        s.drop(100); s.endWhileAsleep(100)
        await eventually { shell.status == "asleep" }
        await shell.wake()
        XCTAssertEqual(shell.pid, 101)
        XCTAssertTrue(plain(output.value).contains("the shell had ended while the sandbox slept; this is a new one"))
        XCTAssertEqual(exits.value, [])
        s.drop(101); s.live.with { $0.remove("sb-1") }
        await eventually { shell.status == "asleep" }
        await shell.wake()
        await eventually { exits.value.count == 1 }
        XCTAssertTrue(plain(output.value).contains("This sandbox is gone"))
        XCTAssertEqual(exits.value, [SandboxShellExit(exitCode: nil)])
    }

    func testUnreachableIsSaidAndTheNextKeystrokeRetries() async throws {
        let s = Shells()
        s.failNext.with { $0 = SandboxError("network down") }
        let (shell, output, _) = open(s)
        await eventually { plain(output.value).contains("Could not reach the sandbox: network down") }
        XCTAssertNil(shell.pid)
        shell.write("ls\r")
        await eventually { s.box.inputs.value == ["ls\r"] }
        XCTAssertEqual(shell.pid, 100)
    }

    func testSpecValidationBannerAndTitle() throws {
        var spec = SandboxShellSpec(libraryId: "lib", sandboxId: "sb-1", title: "owner/app (sandbox)\u{7}", cwd: "/home/user/repository", envs: [:], hint: "make\ttest", apiKey: { "k" })
        XCTAssertNoThrow(try spec.validate())
        XCTAssertEqual(spec.banner, "\u{1b}[2m# Try: make test\u{1b}[0m\r\n")
        XCTAssertEqual(spec.sessionTitle, "owner/app (sandbox)")
        spec.hint = "  "
        XCTAssertEqual(spec.banner, "")
        spec.cwd = "relative"
        XCTAssertThrowsError(try spec.validate())
        spec.cwd = "/x"; spec.sandboxId = "bad id"
        XCTAssertThrowsError(try spec.validate())
    }

    /// The terminal pane's sessions, thread-safe (SandboxTerminals wakes and closes from tasks).
    final class Sessions: SandboxSessions, @unchecked Sendable {
        let state = Locked((snapshots: [String: JSONValue](), created: [SandboxShellSpec](), woken: [String](), closed: [String]()))
        var created: [SandboxShellSpec] { state.value.created }
        var woken: [String] { state.value.woken }
        func get(_ id: String) -> JSONValue? { state.value.snapshots[id] }
        func createSandbox(_ spec: SandboxShellSpec) throws -> JSONValue {
            state.with { s in
                s.created.append(spec)
                let id = "s\(s.created.count)"
                s.snapshots[id] = ["id": .string(id), "status": "running"]
                return s.snapshots[id]!
            }
        }
        func wake(_ id: String) async throws { state.with { $0.woken.append(id) } }
        func close(_ id: String) async throws { state.with { $0.closed.append(id); $0.snapshots[id] = nil } }
    }

    func testTerminalsOnePerRepositoryReusedReplacedClosed() async throws {
        let sessions = Sessions()
        let owned = Locked<[String]>([]), closed = Locked<[String]>([])
        let terminals = SandboxTerminals(sessions: { sessions }, own: { id in owned.with { $0.append(id) } }, closed: { id in closed.with { $0.append(id) } })
        let spec = SandboxShellSpec(libraryId: "lib", sandboxId: "sb-1", title: "t", cwd: "/home/user/repository", envs: [:], hint: "", apiKey: { "k" })
        let first = try terminals.open(spec)
        let again = try terminals.open(spec)
        XCTAssertEqual(first, again)
        XCTAssertEqual(sessions.created.count, 1)
        await eventually { sessions.woken == ["s1"] }
        var moved = spec; moved.sandboxId = "sb-2"
        let replaced = try terminals.open(moved)
        XCTAssertEqual(replaced["id"], "s2")
        await eventually { closed.value == ["s1"] }
        await terminals.close("lib")
        XCTAssertEqual(closed.value, ["s1", "s2"])
        XCTAssertEqual(owned.value, ["s1", "s1", "s2"])
        await terminals.closeAll()
    }
}
