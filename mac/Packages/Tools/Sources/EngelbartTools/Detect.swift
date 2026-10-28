import EngelbartCore
import Foundation

// What is installed (src/main/tools/detect.cjs, 2026-09-23; design D8). One login-shell call lists every git, claude and
// codex on the PATH @bart and the terminal use; the first is what runs, and a wrapper script in front of the real program
// (Hudson's vault shim) is seen through for where the program came from. A program missing from that PATH is looked for
// where its installers put it, and is then run by its full path. Each is asked its version; Claude Code and Codex are
// asked whether they are signed in, and whether the person turned their own updater off.
//
// Every copy counts (2026-09-30, scripts/mac-states): the copies PATH reaches, in its order, then those where the
// installers put them; the first recent enough is used, by its full path when its name runs another (an old Homebrew copy
// first on PATH), and the row says which comes first and how to remove it. A program of the same name that does not print
// Claude Code's or Codex's own version line is another program, and is passed over. A login shell that never runs what it
// is given (a .zshrc that ends in `exec tmux`) makes every program in it fail, and says why. On macOS /usr/bin/git is
// Apple's stub: it is only run once `xcode-select -p` names a developer folder that holds git, because otherwise running
// it opens Apple's installer unasked. When the person's own Git is missing, cannot run or is too old, the Git that came
// with Engelbart stands in (2026-09-28; BundledGit.swift), recorded with the source `bundled`.

public let APPLE_GIT_STUB = "/usr/bin/git"
let LOOKUP_TIMEOUT: TimeInterval = 15
let VERSION_TIMEOUT: TimeInterval = 20
let AUTH_TIMEOUT: TimeInterval = 15
public let SYSTEM_BINS = ["/opt/homebrew/bin", "/usr/local/bin"]

func firstLine(_ text: String) -> String { nonEmptyLines(text).first ?? "" }

/// Every program of each name on PATH, in PATH order; whether the name is (also) a shell alias or function, which the
/// terminal can run and a hidden run cannot (its definition is never printed); and the one switch the shell's
/// environment can hold.
public func lookupCommand(fish: Bool) -> String {
    if fish {
        return "for tool in git claude codex; printf '@tool %s\\n' $tool; command -a -s $tool 2>/dev/null; if functions -q $tool; printf '@alias %s\\n' $tool; end; end; printf '@env DISABLE_AUTOUPDATER=%s\\n' \"$DISABLE_AUTOUPDATER\""
    }
    return "for tool in git claude codex; do printf '@tool %s\\n' \"$tool\"; if [ -n \"$ZSH_VERSION\" ]; then whence -ap \"$tool\" 2>/dev/null; kind=$(whence -w \"$tool\" 2>/dev/null); else type -aP \"$tool\" 2>/dev/null; kind=\"$tool: $(type -t \"$tool\" 2>/dev/null)\"; fi; case \"$kind\" in *alias|*function) printf '@alias %s\\n' \"$tool\";; esac; done; printf '@env DISABLE_AUTOUPDATER=%s\\n' \"${DISABLE_AUTOUPDATER:-}\""
}

public struct Lookup: Equatable, Sendable {
    public var paths: [String: [String]]
    public var aliases: [String]
    public var env: [String: String]
}

private let TOOL_LINE = Rx(#"^@tool (\w+)$"#)
private let ALIAS_LINE = Rx(#"^@alias (\w+)$"#)
private let ENV_LINE = Rx(#"^@env (\w+)=(.*)$"#)

public func parseLookup(_ stdout: String) -> Lookup {
    var paths: [String: [String]] = ["git": [], "claude": [], "codex": []]
    var aliases: [String] = []
    var env: [String: String] = [:]
    var current: String?
    for raw in stdout.components(separatedBy: "\n") {
        let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if line.isEmpty { continue }
        if let tool = TOOL_LINE.exec(line), let name = tool[1] { current = paths[name] != nil ? name : nil; continue }
        if let alias = ALIAS_LINE.exec(line), let name = alias[1] {
            if paths[name] != nil && !aliases.contains(name) { aliases.append(name) }
            continue
        }
        if let setting = ENV_LINE.exec(line), let key = setting[1] { env[key] = setting[2] ?? ""; current = nil; continue }
        if let current, line.hasPrefix("/"), !(paths[current] ?? []).contains(line) { paths[current, default: []].append(line) }
    }
    return Lookup(paths: paths, aliases: aliases, env: env)
}

func isExecutable(_ file: String) -> Bool { ToolShell.isExecutableFile(file) }

func isScript(_ file: String) -> Bool {
    guard let handle = FileHandle(forReadingAtPath: file) else { return false }
    defer { try? handle.close() }
    let head = (try? handle.read(upToCount: 2)) ?? Data()
    return head == Data("#!".utf8)
}

/// `fs.realpathSync`, or the path itself when it cannot be resolved. (NSString's resolvingSymlinksInPath drops /private.)
func realPath(_ file: String) -> String {
    guard let resolved = realpath(file, nil) else { return file }
    defer { free(resolved) }
    return String(cString: resolved)
}

private func listDirectory(_ dir: String) -> [String]? { try? FileManager.default.contentsOfDirectory(atPath: dir) }

private func numericDescending(_ a: String, _ b: String) -> Bool { a.compare(b, options: .numeric) == .orderedDescending }

/// Where installers put each program when PATH does not reach it. Newest nvm Node first.
public func knownPlaces(_ name: String, home: String, systemBins: [String] = SYSTEM_BINS) -> [String] {
    if name == "git" { return [] }
    let relative = name == "claude"
        ? [".local/bin/claude", ".claude/local/claude", ".bun/bin/claude", ".npm-global/bin/claude", ".volta/bin/claude"]
        : [".local/bin/codex", ".bun/bin/codex", ".npm-global/bin/codex", ".volta/bin/codex"]
    let inHome = relative.map { (home as NSString).appendingPathComponent($0) }
    let root = (home as NSString).appendingPathComponent(".nvm/versions/node")
    let nvm = (listDirectory(root) ?? []).filter { Rx(#"^v\d+"#).test($0) }.sorted(by: numericDescending)
        .map { "\(root)/\($0)/bin/\(name)" }
    return inHome + systemBins.map { "\($0)/\(name)" } + nvm
}

/// The Claude Code the Claude desktop app keeps for its own Code tab (2026-10-14, a beta tester: "it says installing claude
/// code, even if it is already installed"): ~/Library/Application Support/Claude/claude-code/<version>/<hash>/claude.app/
/// Contents/MacOS/claude, a whole Claude Code that shares the CLI's sign-in. Newest version first. Looked at after every
/// other place: a CLI of the person's own wins.
public func desktopCopies(_ name: String, home: String) -> [String] {
    guard name == "claude" else { return [] }
    let root = (home as NSString).appendingPathComponent("Library/Application Support/Claude/claude-code")
    guard let entries = listDirectory(root) else { return [] }
    let versions = entries.filter { Rx(#"^\d+\.\d+\.\d+"#).test($0) }.sorted(by: numericDescending)
    var out: [String] = []
    for version in versions.prefix(3) {
        for build in (listDirectory("\(root)/\(version)") ?? []).sorted() {
            let file = "\(root)/\(version)/\(build)/claude.app/Contents/MacOS/claude"
            if isExecutable(file) { out.append(file) }
        }
    }
    return out
}

func isDesktopCopy(_ file: String?) -> Bool { (file ?? "").contains("/Application Support/Claude/claude-code/") }

/// How a program was installed, from where its file really is: this decides how it updates and whether an update can be
/// undone.
public func sourceOf(_ name: String, _ file: String) -> String {
    let real = realPath(file)
    if name == "claude" && isDesktopCopy(real) { return "desktop" } // the Claude app's own: it updates it, never Engelbart
    if name == "git" {
        if real == APPLE_GIT_STUB || real.hasPrefix("/Applications/Xcode") || real.hasPrefix("/Library/Developer/CommandLineTools/") { return "apple" }
        if Rx(#"/(Cellar|Homebrew|homebrew)/"#).test(real) || real.hasPrefix("/opt/homebrew/") { return "homebrew" }
        return "other"
    }
    if name == "claude" && real.contains("/.local/share/claude/versions/") { return "native" }
    if name == "codex" && real.contains("/.codex/packages/standalone/") { return "standalone" }
    if Rx(#"/Caskroom/|/Cellar/"#).test(real) { return "homebrew" }
    if real.contains("/node_modules/") { return real.contains("/.bun/") ? "bun" : "npm" }
    if real.contains("/.bun/") { return "bun" }
    return "other"
}

private let RC_FILE = ["zsh": ".zshrc", "bash": ".bash_profile", "fish": "config.fish"]

/// Why nothing ran: the login shell exited without running the command it was given.
public func shellSilent(_ runner: ToolRunning) -> String {
    let shell = runner.shellPath.isEmpty ? "/bin/zsh" : runner.shellPath
    let rc = RC_FILE[(shell as NSString).lastPathComponent] ?? "startup files"
    return "Your login shell (\(shell)) never runs Engelbart's commands: something in your \(rc) starts another program, such as `exec tmux` or `exec bash`. Put that line inside `if [[ -t 1 ]]; then … fi`, so it only runs in a terminal window."
}

/// What `file --version` says. `other`: it ran, but is not Claude Code or Codex (their own version line is missing: another
/// program of the same name). `silent`: the login shell never ran it (shellSilent).
public struct VersionRead: Equatable, Sendable {
    public var ran = false
    public var version: String?
    public var text = ""
    public var code: Int32?
    public var error: String?
    public var other = false
    public var silent = false
}

private func codeText(_ code: Int32?) -> String { code.map(String.init) ?? "null" }

public func readVersion(_ runner: ToolRunning, _ name: String, _ file: String, direct: Bool = false) async -> VersionRead {
    let label = Requirements[name].name
    for _ in 0..<2 {
        let out = direct
            ? await runner.exec(file, ["--version"], env: [:], timeout: VERSION_TIMEOUT)
            : await runner.shell("exec \"$ENGELBART_TOOL\" --version 2>&1", env: ["ENGELBART_TOOL": file], timeout: VERSION_TIMEOUT)
        if out.timedOut { continue }
        if !direct && out.marked == false {
            return VersionRead(ran: false, version: nil, text: "", code: out.code, error: shellSilent(runner), silent: true)
        }
        let text = "\(out.stdout)\n\(direct ? out.stderr : "")"
        if out.code != 0 {
            let first = firstLine(text)
            return VersionRead(ran: false, version: nil, text: text, code: out.code, error: "\(label) did not start: \(first.isEmpty ? "exit status \(codeText(out.code))" : first)")
        }
        if name != "git" && !Rx(Requirements[name].version).test(text) {
            return VersionRead(ran: true, version: nil, text: text, code: 0, error: "\(file) is another program called \(name), not \(label) (it says \"\(firstLine(text).prefixChars(60))\").", other: true)
        }
        let version = parseVersion(text, name)
        return VersionRead(ran: true, version: version, text: text, code: 0, error: version == nil ? "Could not read the version \(label) printed: \"\(firstLine(text).prefixChars(80))\"" : nil)
    }
    return VersionRead(ran: false, version: nil, text: "", code: nil, error: "\(label) did not answer --version within \(Int(VERSION_TIMEOUT)) seconds")
}

// Sign-in belongs to the CLIs: each is asked for its own status. Engelbart runs Codex on a ChatGPT sign-in only (an API
// key is never used), so an API-key sign-in counts as signed out for it.
// Who is signed in (2026-10-03, Connections' "Connected · <account>"): Claude Code's status JSON has it (`email`); Codex's
// status line does not, so it is the `email` claim of the ID token in Codex's own auth.json (codexAccount). Only that
// address is kept; no token is ever logged or returned. Not found → account nil, never an error.
public struct SignInRead: Equatable, Sendable {
    public var signedIn: Bool?
    public var account: String?
    public var error: String?
    public init(signedIn: Bool?, account: String?, error: String? = nil) { self.signedIn = signedIn; self.account = account; self.error = error }
}

func accountOf(_ value: JSONValue?) -> String? {
    guard let text = value?.string?.trimmingCharacters(in: .whitespacesAndNewlines), isAccount(text) else { return nil }
    return text
}

/// Where Codex keeps its sign-in: $CODEX_HOME, else ~/.codex.
func codexHome(env: [String: String], home: String) -> String {
    if let custom = env["CODEX_HOME"], !custom.isEmpty { return custom }
    return (home as NSString).appendingPathComponent(".codex")
}

private func base64URLDecode(_ text: String) -> Data? {
    guard Rx(#"^[A-Za-z0-9_-]*={0,2}$"#).test(text) else { return nil }
    var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/").replacingOccurrences(of: "=", with: "")
    while s.count % 4 != 0 { s += "=" }
    return Data(base64Encoded: s)
}

/// The account in Codex's sign-in file ($CODEX_HOME, else ~/.codex): its ID token's `email` claim, decoded unverified.
public func codexAccount(env: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) -> String? {
    let file = (codexHome(env: env, home: home) as NSString).appendingPathComponent("auth.json")
    guard let auth = Files.readJSON(URL(fileURLWithPath: file)), let token = auth["tokens"]?["id_token"]?.string else { return nil }
    let parts = token.components(separatedBy: ".")
    guard parts.count > 1, !parts[1].isEmpty, let data = base64URLDecode(parts[1]), let claims = try? JSONValue.parse(data) else { return nil }
    return accountOf(claims["email"])
}

/// Whether Codex's sign-in file is there (a sign-in kept only in the keychain leaves none).
public func codexAuthFile(env: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) -> Bool {
    FileManager.default.fileExists(atPath: (codexHome(env: env, home: home) as NSString).appendingPathComponent("auth.json"))
}

public enum AuthReaders {
    public static let claudeCommand = "exec \"$ENGELBART_TOOL\" auth status --json 2>&1"
    public static let codexCommand = "exec \"$ENGELBART_TOOL\" login status 2>&1"

    /// The JSON object, past any warning printed in front of it; else the one field, as before.
    public static func claude(_ raw: String) -> SignInRead {
        var status: JSONValue?
        if let open = raw.firstIndex(of: "{"), let close = raw.lastIndex(of: "}"), open <= close {
            status = try? JSONValue.parse(String(raw[open...close]))
        }
        if let status, let loggedIn = status["loggedIn"]?.bool {
            return SignInRead(signedIn: loggedIn, account: loggedIn ? accountOf(status["email"]) : nil)
        }
        if let match = Rx(#""loggedIn"\s*:\s*(true|false)"#).exec(raw) { return SignInRead(signedIn: match[1] == "true", account: nil) }
        return SignInRead(signedIn: nil, account: nil)
    }

    public static func codex(_ text: String) -> SignInRead {
        if Rx.i("not logged in").test(text) { return SignInRead(signedIn: false, account: nil) }
        if Rx.i("logged in using chatgpt").test(text) { return SignInRead(signedIn: true, account: nil) }
        if Rx.i("logged in").test(text) {
            return SignInRead(signedIn: false, account: nil, error: "Codex is signed in with an API key; Engelbart uses a ChatGPT sign-in (run `codex login`).")
        }
        return SignInRead(signedIn: nil, account: nil)
    }

    static func command(_ name: String) -> String { name == "claude" ? claudeCommand : codexCommand }
    static func read(_ name: String, _ text: String) -> SignInRead { name == "claude" ? claude(text) : codex(text) }
}

/// `where`: the environment and home for a sign-in file the CLI does not print from (Codex's).
public func readSignIn(_ runner: ToolRunning, _ name: String, _ file: String, env: [String: String], home: String) async -> SignInRead {
    let out = await runner.shell(AuthReaders.command(name), env: ["ENGELBART_TOOL": file], timeout: AUTH_TIMEOUT)
    if out.marked == false { return SignInRead(signedIn: nil, account: nil) }
    var read = AuthReaders.read(name, out.stdout)
    if read.signedIn != true { read.account = nil; return read }
    // Codex signed in with its sign-in in the keychain (2026-10-15: a fresh `codex login` on a new account keeps it there,
    // no ~/.codex/auth.json): Engelbart's agents run Codex in homes of their own that read that file, so every one of them
    // failed. Counted as not signed in, so Connect signs in again with the file (SignIn.swift).
    if name == "codex" && !codexAuthFile(env: env, home: home) {
        return SignInRead(signedIn: false, account: nil, error: "Codex keeps its sign-in in the keychain, where Engelbart’s agents can’t use it. Connect it again.")
    }
    if read.account == nil && name == "codex" { read.account = codexAccount(env: env, home: home) }
    return read
}

/// Whether the person turned the CLI's own updater off: then Engelbart asks before updating it too (design D11).
/// Hudson's ~/.claude.json has `"autoUpdates": false`, so his Claude Code is asked about, never updated silently.
public func updaterOff(_ name: String, env: [String: String], home: String) -> Bool {
    if name == "claude" {
        if Rx.i("^(1|true|yes)$").test((env["DISABLE_AUTOUPDATER"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)) { return true }
        // ~/.claude.json can run to megabytes of project history: the one setting is looked for, not parsed out.
        guard let text = try? String(contentsOfFile: (home as NSString).appendingPathComponent(".claude.json"), encoding: .utf8) else { return false }
        return Rx(#""autoUpdates"\s*:\s*false"#).test(text)
    }
    if name == "codex" {
        let file = (codexHome(env: env, home: home) as NSString).appendingPathComponent("config.toml")
        guard let text = try? String(contentsOfFile: file, encoding: .utf8) else { return false }
        return Rx(#"^\s*check_for_update_on_startup\s*=\s*false\b"#, [.anchorsMatchLines]).test(text)
    }
    return false
}

/// What was found of one program, the input to `observed`.
public struct Found: Sendable {
    public var file: String?
    public var onPath: Bool?
    public var source: String?
    public var version: String?
    public var ran = false
    public var error: String?
    public var signedIn: Bool?
    public var account: String?
    public var updater = false
    public var note: String?

    public init(file: String? = nil, onPath: Bool? = nil, source: String? = nil, ran: Bool = false, version: String? = nil, error: String? = nil,
                signedIn: Bool? = nil, account: String? = nil, updater: Bool = false, note: String? = nil) {
        self.file = file; self.onPath = onPath; self.source = source; self.version = version; self.ran = ran; self.error = error
        self.signedIn = signedIn; self.account = account; self.updater = updater; self.note = note
    }

    func with(_ read: VersionRead) -> Found {
        var copy = self
        copy.ran = read.ran; copy.version = read.version; copy.error = read.error
        return copy
    }
}

private func opt(_ s: String?) -> JSONValue { s.map(JSONValue.string) ?? .null }

/// The observed half of a tool's record (Record.swift), from what was found.
public func observed(_ name: String, _ found: Found = Found()) -> Fields {
    // `installed`: a program is there. Whether it can be used is `status` (a broken one is installed and failed).
    // `onPath`: running it by its name runs this copy; else Engelbart runs it by its full path. `note`: what the row adds.
    // `account`: who is signed in (an email address), only while signed in.
    var out: Fields = [
        "installed": .bool(found.file != nil), "version": opt(found.version), "status": "missing", "path": opt(found.file),
        "onPath": found.onPath.map(JSONValue.bool) ?? .null, "source": opt(found.source), "untested": false,
        "error": opt(found.error), "updaterOff": .bool(found.updater), "note": opt(found.note),
    ]
    if name != "git" {
        let signedIn: Bool? = found.file != nil && found.ran ? found.signedIn : nil
        out["signedIn"] = signedIn.map(JSONValue.bool) ?? .null
        out["account"] = signedIn == true ? opt(accountOf(found.account.map(JSONValue.string))) : .null
    }
    if found.file == nil { return out }
    if !found.ran { out["status"] = "failed"; return out }
    let verdict = judge(name, found.version)
    out["untested"] = .bool(verdict.untested)
    out["status"] = .string(verdict.status == "unknown" ? "ready" : verdict.status)
    if let why = verdict.why, found.error == nil { out["error"] = .string(why) }
    if out["status"]?.string == "ready" && name != "git" && found.signedIn == false { out["status"] = "signed-out" }
    return out
}

/// The person's own Git: the first on the login shell's PATH (Apple's stub read through, never run bare).
func detectOwnGit(_ runner: ToolRunning, _ candidates: [String]) async -> Fields {
    guard let first = candidates.first else { return observed("git") }
    if realPath(first) != APPLE_GIT_STUB {
        let read = await readVersion(runner, "git", first, direct: true)
        return observed("git", Found(file: first, onPath: true, source: sourceOf("git", first)).with(read))
    }
    // Apple's stub: which git it hands over to, if any. No developer folder = no git, and the stub is not touched.
    let selected = await runner.exec("/usr/bin/xcode-select", ["-p"], env: [:], timeout: 5)
    let developer = selected.code == 0 ? firstLine(selected.stdout) : ""
    let real = developer.isEmpty ? "" : (developer as NSString).appendingPathComponent("usr/bin/git")
    if real.isEmpty || !isExecutable(real) { return observed("git") }
    let read = await readVersion(runner, "git", real, direct: true)
    if !read.ran { return observed("git", Found(file: first, onPath: true, source: "apple").with(read)) }
    // The stub itself refuses to run until Xcode's license is accepted (exit 69), which breaks every `git` Claude Code and
    // Codex type.
    let stub = await runner.exec(APPLE_GIT_STUB, ["--version"], env: [:], timeout: VERSION_TIMEOUT)
    if stub.code != 0 && Rx.i("licen[cs]e").test("\(stub.stdout)\n\(stub.stderr)") {
        return observed("git", Found(file: first, onPath: true, source: "apple", ran: false,
                                     error: "Xcode's license has not been accepted, so git will not run (in Terminal: sudo xcodebuild -license accept)."))
    }
    return observed("git", Found(file: first, onPath: true, source: "apple").with(read))
}

/// Their own Git when it works; else Engelbart's (`bundled`: its launcher), unless that cannot run either.
/// `preferBundled`: tests of the stand-in on a Mac that has Git (ENGELBART_GIT=bundled).
func detectGit(_ runner: ToolRunning, _ candidates: [String], bundled: String?, preferBundled: Bool) async -> Fields {
    let own = preferBundled && bundled != nil ? observed("git") : await detectOwnGit(runner, candidates)
    guard let bundled, own["status"]?.string != "ready" else { return own }
    let read = await readVersion(runner, "git", bundled, direct: true)
    if !read.ran && own["installed"]?.bool == true { return own }
    return observed("git", Found(file: bundled, onPath: false, source: "bundled").with(read))
}

/// What to type to take a copy away, from where it really is.
public func removal(_ name: String, _ file: String) -> String? {
    let real = realPath(file)
    if let cask = Rx(#"/Caskroom/([^/]+)/"#).exec(real), let n = cask[1] { return "brew uninstall --cask \(n)" }
    if let formula = Rx(#"/Cellar/([^/]+)/"#).exec(real), let n = formula[1] { return "brew uninstall \(n)" }
    if let npm = Rx(#"/node_modules/((?:@[^/]+/)?[^/]+)/"#).exec(real), let n = npm[1] { return "npm uninstall -g \(n)" }
    return nil
}

struct Copy { let file: String; let onPath: Bool }

/// Every copy of `name`: those PATH reaches, in its order, then those where installers put them; each file once.
func copiesOf(_ name: String, _ candidates: [String], home: String, systemBins: [String]) -> [Copy] {
    var seen = Set<String>()
    var copies: [Copy] = []
    func add(_ file: String, _ onPath: Bool) {
        let key = realPath(file)
        if seen.contains(key) { return }
        seen.insert(key)
        copies.append(Copy(file: file, onPath: onPath))
    }
    for file in candidates { add(file, true) }
    for file in knownPlaces(name, home: home, systemBins: systemBins) where isExecutable(file) { add(file, false) }
    for file in desktopCopies(name, home: home) { add(file, false) }
    return copies
}

func detectAgent(_ runner: ToolRunning, _ name: String, _ candidates: [String], shellEnv: [String: String], home: String, systemBins: [String]) async -> Fields {
    let label = Requirements[name].name
    let updater = updaterOff(name, env: shellEnv, home: home)
    let usable = { (read: VersionRead) -> Bool in
        read.ran && !["outdated", "incompatible"].contains(judge(name, read.version).status)
    }
    // The first copy recent enough, else the first that is this program at all (its row offers Update, or Try again).
    var first: (copy: Copy, read: VersionRead)?
    var chosen: (copy: Copy, read: VersionRead)?
    var other: (copy: Copy, read: VersionRead)? // the first program of the same name that is not it
    for copy in copiesOf(name, candidates, home: home, systemBins: systemBins) {
        let read = await readVersion(runner, name, copy.file)
        if read.other { if other == nil { other = (copy, read) }; continue }
        // The Claude app's copy only when it is recent enough: Engelbart cannot update it (the app does), so an old one
        // would stand in the way of installing Claude Code.
        if isDesktopCopy(copy.file) && !usable(read) { continue }
        if first == nil { first = (copy, read) }
        if usable(read) { chosen = (copy, read); break }
        if read.silent { break } // the login shell runs nothing: every other copy would fail the same way
    }
    guard let pick = chosen ?? first else { return observed(name, Found(error: other?.read.error, updater: updater)) }
    let file = pick.copy.file
    let read = pick.read
    // Its name runs this copy only when it is the first on PATH; otherwise it runs by its full path, and the row says why.
    let byName = candidates.first
    let onPath = pick.copy.onPath && byName == file
    var note: String?
    if let byName, byName != file {
        let shadow = other?.copy.file == byName
        let hint = removal(name, byName)
        // What to do first, the path last: the record keeps a note to 300 characters, and paths can be long.
        let where_ = byName.hasPrefix("\(home)/") ? "~\(byName.dropFirst(home.count))" : byName
        note = shadow
            ? "Typing \(name) in a terminal runs another program of the same name; Engelbart runs \(label) by its full path. The other one is at \(where_)."
            : "An older \(label) comes first on your PATH, so typing \(name) in a terminal runs it; Engelbart uses a newer one.\(hint.map { " To remove the older one: \($0)." } ?? "") It is at \(where_)."
    }
    // A wrapper script in front of the program says nothing about where the program came from: the next one on PATH does.
    let index = candidates.firstIndex(of: file).map { $0 + 1 } ?? 0
    let after = Array(candidates[index...])
    let origin = isScript(file) ? (after.first(where: { !isScript($0) }) ?? file) : file
    let auth = read.ran ? await readSignIn(runner, name, file, env: shellEnv, home: home) : SignInRead(signedIn: nil, account: nil)
    let desktop = isDesktopCopy(file)
    return observed(name, Found(file: file, onPath: onPath, source: desktop ? "desktop" : sourceOf(name, origin), ran: read.ran, version: read.version,
                                error: read.error ?? auth.error, signedIn: auth.signedIn, account: auth.account, updater: updater || desktop, note: note))
}

/// What one check found: each tool's observed fields (with `checkedAt`), the names the shell defines as an alias or
/// function (nil when this detection does not know: the pretend machine), and `lookupError` when the login shell could not
/// be asked (then only the installers' folders were).
public struct DetectResult: Sendable {
    public var tools: [String: Fields]
    public var aliases: [String]?
    public var lookupError: String?
    public init(tools: [String: Fields], aliases: [String]? = nil, lookupError: String? = nil) {
        self.tools = tools; self.aliases = aliases; self.lookupError = lookupError
    }
}

public struct DetectOptions: Sendable {
    public var home: String = NSHomeDirectory()
    public var systemBins: [String] = SYSTEM_BINS
    public var now: @Sendable () -> Date = { Date() }
    /// The launcher of the Git that came with Engelbart (BundledGit.swift), or nil.
    public var bundledGit: String?
    public var preferBundledGit = false
    /// The app's own environment (CODEX_HOME, DISABLE_AUTOUPDATER before the shell's).
    public var environment: [String: String] = ProcessInfo.processInfo.environment
    public init() {}
}

/// Looks for all three, or only the ones named.
public func detectTools(runner: ToolRunning, only: [String] = TOOL_NAMES, options: DetectOptions = DetectOptions()) async -> DetectResult {
    let lookup = await runner.shell(lookupCommand(fish: runner.fish), env: [:], timeout: LOOKUP_TIMEOUT)
    let parsed = parseLookup(lookup.stdout)
    let lookupError: String? = lookup.marked == true ? nil
        : lookup.timedOut ? "The login shell (\(runner.shellPath)) did not answer within \(Int(LOOKUP_TIMEOUT)) seconds." : shellSilent(runner)
    let checkedAt = Time.iso(options.now())
    var shellEnv = options.environment
    for (k, v) in parsed.env { shellEnv[k] = v }
    let found = await withTaskGroup(of: (String, Fields).self) { group -> [String: Fields] in
        for name in only {
            group.addTask {
                let fields = name == "git"
                    ? await detectGit(runner, parsed.paths["git"] ?? [], bundled: options.bundledGit, preferBundled: options.preferBundledGit)
                    : await detectAgent(runner, name, parsed.paths[name] ?? [], shellEnv: shellEnv, home: options.home, systemBins: options.systemBins)
                return (name, fields)
            }
        }
        var out: [String: Fields] = [:]
        for await (name, fields) in group { out[name] = fields }
        return out
    }
    var tools: [String: Fields] = [:]
    for name in only {
        var fields = found[name] ?? observed(name)
        if fields["error"]?.string == nil { fields["error"] = fields["status"]?.string == "missing" ? opt(lookupError) : .null }
        fields["checkedAt"] = .string(checkedAt)
        tools[name] = fields
    }
    return DetectResult(tools: tools, aliases: parsed.aliases, lookupError: lookupError)
}
