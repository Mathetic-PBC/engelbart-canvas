import Darwin
import Foundation
import XCTest

/// A fresh temporary directory, removed after the test (fs.mkdtempSync + t.after rm).
func temporaryDirectory(_ test: XCTestCase, prefix: String = "engelbart-terminal-") -> String {
    let base = NSTemporaryDirectory() + prefix + UUID().uuidString.prefix(8)
    try! FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
    // Resolve /var → /private/var so a shell's $PWD matches.
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
    let resolved = realpath(base, &buffer) != nil ? String(cString: buffer) : base
    test.addTeardownBlock { try? FileManager.default.removeItem(atPath: resolved) }
    return resolved
}

struct Spawned { var status: Int32; var stdout: String; var stderr: String }

/// spawnSync(file, args, { detached: true, env, input, timeout }): the child runs in a session of its own with no
/// controlling terminal, so an interactive zsh reads the input it is given rather than the test runner's terminal.
func spawnDetached(_ file: String, _ args: [String], env: [String: String], input: String? = nil, cwd: String? = nil, timeout: TimeInterval = 10) -> Spawned {
    var attr = posix_spawnattr_t(nil as OpaquePointer?)
    posix_spawnattr_init(&attr)
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID))
    var actions = posix_spawn_file_actions_t(nil as OpaquePointer?)
    posix_spawn_file_actions_init(&actions)
    var inPipe: [Int32] = [0, 0], outPipe: [Int32] = [0, 0], errPipe: [Int32] = [0, 0]
    pipe(&inPipe); pipe(&outPipe); pipe(&errPipe)
    posix_spawn_file_actions_adddup2(&actions, inPipe[0], 0)
    posix_spawn_file_actions_adddup2(&actions, outPipe[1], 1)
    posix_spawn_file_actions_adddup2(&actions, errPipe[1], 2)
    for fd in inPipe + outPipe + errPipe { posix_spawn_file_actions_addclose(&actions, fd) }
    if let cwd { posix_spawn_file_actions_addchdir_np(&actions, cwd) }
    let argv = ([file] + args).map { strdup($0) } + [nil]
    let envp = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, file, &actions, &attr, argv, envp)
    argv.forEach { free($0) }; envp.forEach { free($0) }
    posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attr)
    close(inPipe[0]); close(outPipe[1]); close(errPipe[1])
    guard rc == 0 else { return Spawned(status: -1, stdout: "", stderr: String(cString: strerror(rc))) }
    if let input { _ = input.withCString { write(inPipe[1], $0, strlen($0)) } }
    close(inPipe[1])
    var out = Data(), err = Data()
    let group = DispatchGroup()
    group.enter(); DispatchQueue.global().async { out = FileHandle(fileDescriptor: outPipe[0], closeOnDealloc: true).readDataToEndOfFile(); group.leave() }
    group.enter(); DispatchQueue.global().async { err = FileHandle(fileDescriptor: errPipe[0], closeOnDealloc: true).readDataToEndOfFile(); group.leave() }
    let deadline = Date().addingTimeInterval(timeout)
    var status: Int32 = 0
    while waitpid(pid, &status, WNOHANG) == 0 {
        if Date() > deadline { kill(pid, SIGKILL) }
        usleep(10_000)
    }
    _ = group.wait(timeout: .now() + 2)
    let exit = (status & 0x7f) == 0 ? (status >> 8) & 0xff : -1
    return Spawned(status: exit, stdout: String(decoding: out, as: UTF8.self), stderr: String(decoding: err, as: UTF8.self))
}

func write(_ text: String, to path: String, mode: Int16? = nil) {
    try! FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try! Data(text.utf8).write(to: URL(fileURLWithPath: path))
    if let mode { chmod(path, mode_t(mode)) }
}
