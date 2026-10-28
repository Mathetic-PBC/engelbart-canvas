import Foundation

// Signing in to Claude Code or Codex (src/main/tools/sign-in.cjs, 2026-09-23; design D16): the CLI's own sign-in, run in a
// hidden terminal (a PTY, so it behaves as it does in one). The CLI opens the browser itself and ends when the browser
// hands it the sign-in. The page's address, when it prints one, is passed on so the dialog can open it again; a "press
// Enter" before opening the browser is answered. The CLI's folder goes last on PATH, as in the terminal: Claude Code found
// where the login shell's PATH does not reach (~/.local/bin on a new account) otherwise signs in saying its installation
// "is not in your PATH" (2026-09-29).
//
// Signing out (2026-10-03, Connections): the CLI's own logout, `claude auth logout` / `codex logout`. Neither asks
// anything, so it runs in the login shell as the sign-in check does (Detect.swift AuthReaders), not in a terminal.

public let SIGN_IN_COMMANDS = [
    "claude": "exec \"$ENGELBART_TOOL\" auth login --claudeai",
    // its sign-in kept in ~/.codex/auth.json, never only the keychain: Engelbart's agents read that file (Detect.swift)
    "codex": "exec \"$ENGELBART_TOOL\" login -c 'cli_auth_credentials_store=\"file\"'",
]
public let SIGN_OUT_COMMANDS = [
    "claude": "exec \"$ENGELBART_TOOL\" auth logout 2>&1",
    "codex": "exec \"$ENGELBART_TOOL\" logout 2>&1",
]
let SIGN_OUT_TIMEOUT: TimeInterval = 30
private let URL_RE = Rx(#"https://[^\s"'<>]+"#)
private let PRESS_ENTER = Rx.i("press (enter|return)")

/// How a sign-in or sign-out ended. `code` nil: cancelled (a signal) or never finished; `output`: the last line when it
/// failed, else "".
public struct SignInExit: Equatable, Sendable {
    public var code: Int32?
    public var output: String
    public init(code: Int32?, output: String) { self.code = code; self.output = output }
}

/// One sign-in under way.
public protocol SignInRun: AnyObject, Sendable {
    func wait() async -> SignInExit
    func kill()
}

/// Starts the CLI's sign-in for (name, file); `onUrl` is told the page's address once.
public typealias SignInStarter = @Sendable (_ name: String, _ file: String, _ onUrl: @escaping @Sendable (String) -> Void) -> SignInRun
public typealias SignOutRunner = @Sendable (_ name: String, _ file: String) async -> SignInExit

/// A value that arrives once, awaited any number of times (a JS promise).
public final class Once<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T?
    private var waiters: [CheckedContinuation<T, Never>] = []
    public init() {}

    /// The first call wins.
    public func resolve(_ v: T) {
        lock.lock()
        guard value == nil else { lock.unlock(); return }
        value = v
        let w = waiters
        waiters = []
        lock.unlock()
        w.forEach { $0.resume(returning: v) }
    }

    public var isResolved: Bool { lock.lock(); defer { lock.unlock() }; return value != nil }

    public func wait() async -> T {
        await withCheckedContinuation { (c: CheckedContinuation<T, Never>) in
            lock.lock()
            if let value { lock.unlock(); c.resume(returning: value); return }
            waiters.append(c)
            lock.unlock()
        }
    }
}

final class PtySignIn: SignInRun, @unchecked Sendable {
    let pty = PtyProcess()
    let done = Once<SignInExit>()
    private let lock = NSLock()
    private var output = ""
    private var url: String?
    private var pressed = false

    func wait() async -> SignInExit { await done.wait() }
    func kill() { pty.kill() }

    func take(_ data: String, onUrl: (String) -> Void) {
        lock.lock()
        output = String((output + data).suffix(50_000))
        let text = stripANSI(output)
        var found: String?
        if url == nil, let match = URL_RE.exec(text)?[0] { url = match; found = match }
        var press = false
        if !pressed && PRESS_ENTER.test(text) { pressed = true; press = true }
        lock.unlock()
        if let found { onUrl(found) }
        if press { pty.write("\r") }
    }

    func ended(_ code: Int32, _ signal: Int32?) {
        // A sign-in ended by Cancel (or the ten-minute limit) comes back with a signal: it is reported as { code: nil },
        // never as a success, and says nothing.
        if signal != nil { done.resolve(SignInExit(code: nil, output: "")); return }
        lock.lock(); let text = output; lock.unlock()
        let last = nonEmptyLines(stripANSI(text)).last ?? ""
        done.resolve(SignInExit(code: code, output: code == 0 ? "" : last.prefixChars(200)))
    }
}

/// The real sign-in: `shell` is the login shell (ToolRunner.shellPath); `environment` read at each sign-in.
public func makeSignInStarter(shell: String, environment: @escaping @Sendable () -> [String: String] = { ProcessInfo.processInfo.environment },
                              home: String = NSHomeDirectory()) -> SignInStarter {
    return { name, file, onUrl in
        var env = ToolShell.sanitize(environment())
        env["ENGELBART_TOOL"] = file
        env["ENGELBART_AGENT_PATH"] = (file as NSString).deletingLastPathComponent
        let run = PtySignIn()
        run.pty.onData = { [weak run] data in run?.take(data, onUrl: onUrl) }
        run.pty.onExit { [weak run] code, signal in run?.ended(code, signal) }
        do {
            // xterm-256color (sanitize sets TERM), 400 columns so a long sign-in address is never wrapped, 40 rows.
            try run.pty.spawn(shell, ToolShell.loginShellArgs(shell, SIGN_IN_COMMANDS[name] ?? "", env), env: env, cwd: home, cols: 400, rows: 40)
        } catch {
            run.done.resolve(SignInExit(code: 1, output: "The sign-in could not start: \(error.localizedDescription)".prefixChars(200)))
        }
        return run
    }
}

/// The CLI's logout, through the tool check's runner. Output is the last line when it failed.
public func makeSignOutRunner(runner: ToolRunning) -> SignOutRunner {
    return { name, file in
        let out = await runner.shell(SIGN_OUT_COMMANDS[name] ?? "", env: ["ENGELBART_TOOL": file], timeout: SIGN_OUT_TIMEOUT)
        if out.timedOut { return SignInExit(code: nil, output: "it did not finish within \(Int(SIGN_OUT_TIMEOUT)) seconds") }
        if out.marked == false { return SignInExit(code: nil, output: shellSilent(runner)) }
        let last = nonEmptyLines(stripANSI(out.stdout)).last ?? "exit status \(out.code.map(String.init) ?? "null")"
        return SignInExit(code: out.code, output: out.code == 0 ? "" : last.prefixChars(200))
    }
}
