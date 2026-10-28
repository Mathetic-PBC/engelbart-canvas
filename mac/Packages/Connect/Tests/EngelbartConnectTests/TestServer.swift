import Foundation
import Network
import XCTest
import EngelbartCore
@testable import EngelbartConnect

/// A loopback HTTP server answering from fixtures (http://127.0.0.1:<port>), for the pages, downloads and sign-in flows.
/// No network beyond the machine.
final class TestServer: @unchecked Sendable {
    struct Reply { var status = 200; var type = "text/html; charset=utf-8"; var headers: [String: String] = [:]; var body: Data
        init(_ text: String, status: Int = 200, type: String = "text/html; charset=utf-8", headers: [String: String] = [:]) { self.status = status; self.type = type; self.headers = headers; body = Data(text.utf8) }
        init(data: Data, type: String, headers: [String: String] = [:]) { self.type = type; self.headers = headers; body = data } }
    private let listener: NWListener
    private let queue = DispatchQueue(label: "connect.test-server")
    private let lock = NSLock()
    private var routes: [String: Reply] = [:]
    private(set) var requests: [(method: String, path: String, headers: [String: String])] = []
    var port: UInt16 { listener.port?.rawValue ?? 0 }
    var base: String { "http://127.0.0.1:\(port)" }

    init() throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: 0)
        listener = try NWListener(using: params)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
        listener.newConnectionHandler = { [weak self] c in self?.serve(c) }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 5)
    }
    deinit { listener.cancel() }

    func route(_ path: String, _ reply: Reply) { lock.lock(); routes[path] = reply; lock.unlock() }
    func seen(_ path: String) -> Int { lock.lock(); defer { lock.unlock() }; return requests.filter { $0.path == path }.count }

    private func serve(_ c: NWConnection) {
        c.start(queue: queue)
        var buffer = Data()
        func readMore() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, _ in
                guard let self else { return }
                if let data { buffer.append(data) }
                if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                    let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
                    let first = head.first?.components(separatedBy: " ") ?? []
                    var headers: [String: String] = [:]
                    for line in head.dropFirst() { if let i = line.firstIndex(of: ":") { headers[line[..<i].lowercased()] = line[line.index(after: i)...].trimmingCharacters(in: .whitespaces) } }
                    let method = first.first ?? "GET"
                    let full = first.count > 1 ? first[1] : "/"
                    let path = full.components(separatedBy: "?")[0]
                    self.lock.lock(); self.requests.append((method, path, headers)); let reply = self.routes[path] ?? Reply("Not found", status: 404, type: "text/plain"); self.lock.unlock()
                    var text = "HTTP/1.1 \(reply.status) X\r\nContent-Type: \(reply.type)\r\nContent-Length: \(reply.body.count)\r\nConnection: close\r\n"
                    for (k, v) in reply.headers { text += "\(k): \(v)\r\n" }
                    text += "\r\n"
                    c.send(content: Data(text.utf8) + reply.body, completion: .contentProcessed { _ in c.cancel() })
                } else if done { c.cancel() } else { readMore() }
            }
        }
        readMore()
    }
}

/// Tiny `claude` and `codex` executables first on PATH (as the Bart package's tests do): they print recorded event lines,
/// log their arguments, input and environment, and codex writes its `-o` file. The login shell, the command building,
/// the process handling and the parsing are the package's own.
final class FakeCLIs {
    let root: String, dir: String, log: String, home: String
    init(claudeLines: [String] = [], codexLines: [String] = [], codexOut: String = "", claudeExit: Int = 0) throws {
        root = TempDir.make("fakecli")
        dir = root + "/bin"; log = root + "/log"; home = root + "/home"
        for d in [dir, log, home] { try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true) }
        try (claudeLines.joined(separator: "\n") + "\n").write(toFile: root + "/claude.jsonl", atomically: true, encoding: .utf8)
        try (codexLines.joined(separator: "\n") + "\n").write(toFile: root + "/codex.jsonl", atomically: true, encoding: .utf8)
        try codexOut.write(toFile: root + "/codex.out", atomically: true, encoding: .utf8)
        let claude = """
        #!/bin/sh
        n=$(ls "$FAKE_LOG" | grep -c claude-args)
        printf '%s\\n' "$@" > "$FAKE_LOG/claude-args-$n"
        cat > "$FAKE_LOG/claude-input-$n"
        env > "$FAKE_LOG/claude-env-$n"
        cat "\(root)/claude.jsonl"
        exit \(claudeExit)
        """
        let codex = """
        #!/bin/sh
        n=$(ls "$FAKE_LOG" | grep -c codex-args)
        printf '%s\\n' "$@" > "$FAKE_LOG/codex-args-$n"
        out=""; prev=""
        for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done
        cat > "$FAKE_LOG/codex-input-$n"
        env > "$FAKE_LOG/codex-env-$n"
        if [ -n "$CODEX_HOME" ] && [ -f "$CODEX_HOME/config.toml" ]; then cp "$CODEX_HOME/config.toml" "$FAKE_LOG/codex-config-$n"; fi
        if [ -n "$CODEX_HOME" ] && [ -f "$CODEX_HOME/AGENTS.md" ]; then cp "$CODEX_HOME/AGENTS.md" "$FAKE_LOG/codex-agents-$n"; fi
        cat "\(root)/codex.jsonl"
        if [ -n "$out" ]; then cat "\(root)/codex.out" > "$out"; fi
        """
        for (name, text) in [("claude", claude), ("codex", codex)] {
            let path = dir + "/" + name
            try text.write(toFile: path, atomically: true, encoding: .utf8)
            chmod(path, 0o755)
        }
        try #"{"auth_mode":"chatgpt","tokens":{"a":1}}"#.write(toFile: root + "/auth.json", atomically: true, encoding: .utf8)
    }
    var auth: String { root + "/auth.json" }
    /// These first on PATH, a home with no rc files.
    var environment: [String: String] { ["SHELL": "/bin/zsh", "HOME": home, "ZDOTDIR": home, "PATH": "\(dir):/usr/bin:/bin", "FAKE_LOG": log, "LANG": "en_US.UTF-8", "CODEX_HOME": home + "/.codex"] }
    func file(_ name: String) -> String { (try? String(contentsOfFile: "\(log)/\(name)", encoding: .utf8)) ?? "" }
    func args(_ cli: String, _ n: Int = 0) -> [String] { Array(file("\(cli)-args-\(n)").components(separatedBy: "\n").dropLast()) }
    func agents(terminal: AgentTerminal? = nil) -> CLIAgents {
        CLIAgents(environment: environment, runDirectory: root + "/runs", interviewHome: root + "/interview", codexAuthFile: auth, terminal: terminal, retryWaits: [0, 0], sleep: { _, _ in })
    }
}

extension TempDir {
    /// A folder kept until the process ends (for helpers that outlive one scope).
    static func make(_ prefix: String) -> String {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(prefix)-\(UUID().uuidString)").resolvingSymlinksInPath()
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url.path
    }
}

/// An `until` for any test: polls `check` every 20 ms up to `timeout` seconds.
func eventually(_ timeout: Double = 10, _ check: () async -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end { if await check() { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return await check()
}
