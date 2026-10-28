import EngelbartCore
import Foundation
import XCTest
@testable import EngelbartTools

func temp(_ prefix: String = "engelbart-tools-") -> String {
    let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("\(prefix)\(UUID().uuidString.prefix(8))")
    try! FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return realPath(dir)
}

func write(_ file: String, _ text: String, mode: Int16? = nil) {
    try! FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try! text.write(toFile: file, atomically: false, encoding: .utf8)
    if let mode { chmod(file, mode_t(mode)) }
}

func mkdirs(_ dir: String) { try! FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true) }

/// A runner that answers from a table: `shell` by command text (and the tool it is asked about), `exec` by "file args" or file.
final class TableRunner: ToolRunning, @unchecked Sendable {
    struct Answer {
        var tool: String?
        var make: () -> ExecResult
        init(tool: String? = nil, _ result: ExecResult) { self.tool = tool; self.make = { result } }
        init(tool: String? = nil, make: @escaping () -> ExecResult) { self.tool = tool; self.make = make }
    }
    struct Call: Equatable { var kind: String; var command: String; var env: [String: String] }

    let shellPath = "/bin/zsh"
    let fish: Bool
    var lookup: String
    var shellTable: [(String, Answer)]
    var execTable: [String: Answer]
    var shellOverride: ((String, [String: String]) -> ExecResult)?
    private let lock = NSLock()
    private var _calls: [Call] = []
    var calls: [Call] { lock.lock(); defer { lock.unlock() }; return _calls }

    init(lookup: String = "", shell: [(String, Answer)] = [], exec: [String: Answer] = [:], fish: Bool = false) {
        self.lookup = lookup; self.shellTable = shell; self.execTable = exec; self.fish = fish
    }

    static func ok(_ stdout: String = "", code: Int32? = 0, stderr: String = "", timedOut: Bool = false, marked: Bool? = true) -> ExecResult {
        ExecResult(code: code, stdout: stdout, stderr: stderr, timedOut: timedOut, marked: marked)
    }

    func shell(_ command: String, env: [String: String], timeout: TimeInterval) async -> ExecResult {
        lock.lock(); _calls.append(Call(kind: "shell", command: command, env: env)); lock.unlock()
        if let shellOverride { return shellOverride(command, env) }
        if command.hasPrefix("for tool in") { return TableRunner.ok(lookup) }
        if let (_, answer) = shellTable.first(where: { command.contains($0.0) && ($0.1.tool == nil || $0.1.tool == env["ENGELBART_TOOL"]) }) {
            var out = answer.make()
            if out.marked == nil { out.marked = true }
            return out
        }
        return TableRunner.ok("command not found", code: 127)
    }

    func exec(_ file: String, _ args: [String], env: [String: String], timeout: TimeInterval, cwd: String?, input: String?) async -> ExecResult {
        lock.lock(); _calls.append(Call(kind: "exec", command: ([file] + args).joined(separator: " "), env: env)); lock.unlock()
        let key = ["\(file) \(args.joined(separator: " "))", file].first { execTable[$0] != nil }
        if let key, let answer = execTable[key] { return answer.make() }
        return ExecResult(code: 1, missing: true)
    }
}

/// config.json in a temporary root, as the Store keeps it (src/main/store/home.cjs ensureHome / readConfig / writeTools):
/// the tools record is written only while the file parses.
final class ConfigFile: @unchecked Sendable {
    let root: String
    var file: String { (root as NSString).appendingPathComponent("config.json") }

    init() {
        root = temp("engelbart-config-")
        try! Files.writeJSON(["dataRoot": .string(root), "tools": normalizeTools(nil).json], to: URL(fileURLWithPath: file))
    }

    var config: JSONValue? { Files.readJSON(URL(fileURLWithPath: file)) }
    var tools: ToolsRecord { normalizeTools(config?["tools"]) }

    @discardableResult
    func writeTools(_ tools: JSONValue) -> JSONValue? {
        guard case .object(var onDisk)? = config else { return nil }
        onDisk["tools"] = tools
        try! Files.writeJSON(.object(onDisk), to: URL(fileURLWithPath: file))
        return tools
    }

    var storage: ToolsStorage {
        ToolsStorage(read: { [self] in config?["tools"] }, write: { [self] in writeTools($0) })
    }
}

/// Waits (on the main actor) until `condition` holds, or fails after `timeout`.
@MainActor
func eventually(_ timeout: TimeInterval = 5, _ message: String = "", _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > deadline { XCTFail("timed out: \(message)", file: file, line: line); return }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
}

func status(_ fields: Fields?) -> String? { fields?["status"]?.string }
