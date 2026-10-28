import Foundation
import XCTest
import EngelbartCore
@testable import EngelbartSandbox

/// A command handle whose end the test decides.
final class FakeHandle: E2BCommandHandle, @unchecked Sendable {
    let pid: Int
    let end = Deferred<CommandResult>()
    var disconnected = false
    var killed = false
    var onDisconnect: (() -> Void)?
    init(pid: Int = 1) { self.pid = pid }
    func wait() async throws -> CommandResult { try await end.wait() }
    func disconnect() async { disconnected = true; onDisconnect?() }
    func kill() async throws -> Bool { killed = true; return true }
    func exit(_ code: Int) {
        if code == 0 { end.resolve(CommandResult(exitCode: 0)) }
        else { end.reject(SandboxError("exit status \(code)", name: "CommandExitError", exitCode: code)) }
    }
    func drop() { end.reject(SandboxError("[unavailable] the connection to sandbox ended before the stream completed", name: "TimeoutError")) }
}

/// An E2B sandbox whose commands and files are closures.
final class FakeSandbox: E2BSandbox, @unchecked Sendable {
    let sandboxId: String
    var host = "preview.example"
    let commands = Locked<[String]>([])
    let options = Locked<[CommandOptions]>([])
    let files = Locked<[String: String]>([:])
    let kills = Locked(0)
    let timeouts = Locked<[Int]>([])
    var runHandler: (String, CommandOptions) async throws -> CommandResult = { _, _ in CommandResult(exitCode: 0) }
    var startHandler: (String, CommandOptions) async throws -> E2BCommandHandle = { _, _ in FakeHandle() }
    var readHandler: (String, Int) async throws -> Data = { _, _ in Data() }
    var writeHandler: (String, String) async throws -> Void = { _, _ in }
    var ptyCreateHandler: ((Int, Int, String?, [String: String], @escaping @Sendable (Data) -> Void) async throws -> E2BCommandHandle)?
    var ptyConnectHandler: ((Int, @escaping @Sendable (Data) -> Void) async throws -> E2BCommandHandle)?
    let ptyCalls = Locked<[String]>([])
    let inputs = Locked<[String]>([])

    init(_ id: String = "sb-test") { sandboxId = id }

    func getHost(_ port: Int) -> String { host }
    func setTimeout(_ timeoutMs: Int, requestTimeoutMs: Int?) async throws { timeouts.with { $0.append(timeoutMs) } }
    func kill(requestTimeoutMs: Int?) async throws { kills.with { $0 += 1 } }
    func run(_ command: String, _ o: CommandOptions) async throws -> CommandResult {
        commands.with { $0.append(command) }; options.with { $0.append(o) }
        return try await runHandler(command, o)
    }
    func start(_ command: String, _ o: CommandOptions) async throws -> E2BCommandHandle {
        commands.with { $0.append(command) }; options.with { $0.append(o) }
        return try await startHandler(command, o)
    }
    func writeFile(_ path: String, _ text: String) async throws { files.with { $0[path] = text }; try await writeHandler(path, text) }
    func readFile(_ path: String, maxBytes: Int, signal: AbortSignal?, requestTimeoutMs: Int?) async throws -> Data { try await readHandler(path, maxBytes) }
    func ptyCreate(cols: Int, rows: Int, cwd: String?, envs: [String: String], timeoutMs: Int, requestTimeoutMs: Int?, onData: @escaping @Sendable (Data) -> Void) async throws -> E2BCommandHandle {
        ptyCalls.with { $0.append("create") }
        return try await ptyCreateHandler!(cols, rows, cwd, envs, onData)
    }
    func ptyConnect(pid: Int, timeoutMs: Int, requestTimeoutMs: Int?, onData: @escaping @Sendable (Data) -> Void) async throws -> E2BCommandHandle {
        ptyCalls.with { $0.append("connect \(pid)") }
        return try await ptyConnectHandler!(pid, onData)
    }
    func ptySendInput(pid: Int, _ data: Data, requestTimeoutMs: Int?) async throws { inputs.with { $0.append(String(decoding: data, as: UTF8.self)) } }
    func ptyResize(pid: Int, cols: Int, rows: Int, requestTimeoutMs: Int?) async throws { ptyCalls.with { $0.append("resize \(pid) \(cols)x\(rows)") } }
    func ptyKill(pid: Int, requestTimeoutMs: Int?) async throws -> Bool { ptyCalls.with { $0.append("kill \(pid)") }; return true }
}

/// The static E2B API, as closures; every call is recorded.
final class FakeE2B: E2BService, @unchecked Sendable {
    let calls = Locked<[String]>([])
    var createHandler: (String, E2BCreateOptions) async throws -> E2BSandbox = { _, _ in FakeSandbox() }
    var connectHandler: (String, Int?) async throws -> E2BSandbox = { id, _ in FakeSandbox(id) }
    var infoHandler: (String) async throws -> E2BSandboxInfo = { E2BSandboxInfo(sandboxId: $0, state: "running", endAt: Time.ms() + 3_600_000) }
    var pauseHandler: (String) async throws -> Bool = { _ in true }
    var listHandler: ([String: String]) async throws -> [E2BSandboxInfo] = { _ in [] }
    var setTimeoutHandler: (String, Int) async throws -> Void = { _, _ in }
    let keys = Locked<[String]>([])

    func create(template: String, _ options: E2BCreateOptions, apiKey: String) async throws -> E2BSandbox {
        calls.with { $0.append("create \(template)") }; keys.with { $0.append(apiKey) }
        return try await createHandler(template, options)
    }
    func connect(_ sandboxId: String, apiKey: String, timeoutMs: Int?, requestTimeoutMs: Int?) async throws -> E2BSandbox {
        calls.with { $0.append("connect \(sandboxId) \(timeoutMs.map(String.init) ?? "-")") }; keys.with { $0.append(apiKey) }
        return try await connectHandler(sandboxId, timeoutMs)
    }
    func kill(_ sandboxId: String, apiKey: String, requestTimeoutMs: Int?) async throws -> Bool { calls.with { $0.append("kill \(sandboxId)") }; return true }
    func getInfo(_ sandboxId: String, apiKey: String, requestTimeoutMs: Int?) async throws -> E2BSandboxInfo {
        calls.with { $0.append("info \(sandboxId)") }
        return try await infoHandler(sandboxId)
    }
    func pause(_ sandboxId: String, apiKey: String, requestTimeoutMs: Int?) async throws -> Bool { calls.with { $0.append("pause \(sandboxId)") }; return try await pauseHandler(sandboxId) }
    func setTimeout(_ sandboxId: String, timeoutMs: Int, apiKey: String, requestTimeoutMs: Int?) async throws {
        calls.with { $0.append("setTimeout \(sandboxId) \(timeoutMs)") }; keys.with { $0.append(apiKey) }
        try await setTimeoutHandler(sandboxId, timeoutMs)
    }
    func list(metadata: [String: String], states: [String], apiKey: String, requestTimeoutMs: Int?) async throws -> [E2BSandboxInfo] {
        calls.with { $0.append("list") }
        return try await listHandler(metadata)
    }
}

/// An AES-GCM secure storage with its own key (no Keychain).
final class MemorySecure: SecureStorage {
    let key = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    var available = true
    var isEncryptionAvailable: Bool { available }
    func encrypt(_ text: String) throws -> Data {
        // Not secure; reversible XOR with the key, enough to prove values never sit in clear text.
        Data(text.utf8.enumerated().map { $0.element ^ key[$0.offset % 32] }) + Data("tag".utf8)
    }
    func decrypt(_ data: Data) throws -> String {
        guard data.suffix(3) == Data("tag".utf8) else { throw SandboxError("bad") }
        return String(decoding: data.dropLast(3).enumerated().map { $0.element ^ key[$0.offset % 32] }, as: UTF8.self)
    }
}

/// A fake HTTP layer for the package's own requests.
final class FakeFetcher: HTTPFetching, @unchecked Sendable {
    let requests = Locked<[URLRequest]>([])
    var handler: (URLRequest) async throws -> (Int, Data)
    init(_ handler: @escaping (URLRequest) async throws -> (Int, Data)) { self.handler = handler }
    func fetch(_ request: URLRequest, followRedirects: Bool) async throws -> (Int, [String: String], Data) {
        requests.with { $0.append(request) }
        let (status, data) = try await handler(request)
        return (status, [:], data)
    }
}

func temporaryDirectory() -> String {
    let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("eb-sandbox-\(UUID().uuidString.prefix(8))")
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return dir
}

func database() throws -> SQLiteSandboxDatabase {
    try SQLiteSandboxDatabase(path: (temporaryDirectory() as NSString).appendingPathComponent("library.sqlite"), createSchema: true)
}

/// Waits until `condition` holds (or fails after `timeout`).
func eventually(_ timeout: Double = 3, _ message: String = "condition", _ condition: () -> Bool) async {
    let end = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > end { XCTFail("timed out waiting for \(message)"); return }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
}

func settle() async { for _ in 0..<20 { await Task.yield(); try? await Task.sleep(nanoseconds: 2_000_000) } }

func assertThrows<T>(_ expression: @autoclosure () async throws -> T, _ pattern: String, file: StaticString = #filePath, line: UInt = #line) async {
    do { _ = try await expression(); XCTFail("expected an error matching \(pattern)", file: file, line: line) }
    catch { XCTAssertTrue(message(of: error).matches(pattern), "\"\(message(of: error))\" does not match \(pattern)", file: file, line: line) }
}

func assertEqualAsync<T: Equatable>(_ a: @autoclosure () async throws -> T, _ b: @autoclosure () throws -> T, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) async throws {
    let x = try await a()
    XCTAssertEqual(x, try b(), message, file: file, line: line)
}

func assertNilAsync<T>(_ a: @autoclosure () async throws -> T?, file: StaticString = #filePath, line: UInt = #line) async throws {
    let x = try await a()
    XCTAssertNil(x, file: file, line: line)
}
