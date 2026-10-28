import Foundation
import AppKit
import EngelbartCore

// Ports of src/main/onboarding/: disk-access.cjs, providers.cjs, browsers.cjs, obsidian-tree.cjs and digest.cjs.

// MARK: disk-access.cjs

/// Whether macOS already lets Engelbart read the folders it guards; Safari's sign-ins need it (S9). "Grant disk access"
/// opens System Settings ▸ Privacy & Security ▸ Full Disk Access, nothing else: no guide window, no helper popup.
/// ENGELBART_DISK_ACCESS ('granted' | 'denied') stands in for this Mac.
public struct DiskAccess: Sendable {
    public static let pane = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
    public var homeDir: String
    public var fake: String
    public var open: @Sendable (String) async -> Bool
    public init(homeDir: String, fake: String? = nil, open: (@Sendable (String) async -> Bool)? = nil) {
        self.homeDir = homeDir
        self.fake = fake ?? ProcessInfo.processInfo.environment["ENGELBART_DISK_ACCESS"] ?? ""
        self.open = open ?? { url in ((try? await ProcessRunner.run("/usr/bin/open", [url], timeout: 10))?.exit.succeeded) ?? false }
    }
    public static func probeFile(_ homeDir: String) -> String { (homeDir as NSString).appendingPathComponent("Library/Application Support/com.apple.TCC/TCC.db") }
    /// Whether this process may read it → true | false | nil (no such file: unknown).
    public static func canReadHere(_ homeDir: String) -> Bool? {
        let fd = Darwin.open(probeFile(homeDir), O_RDONLY)
        if fd >= 0 { Darwin.close(fd); return true }
        return errno == ENOENT ? nil : false
    }
    public func status() -> JSONValue { ["platform": "darwin", "granted": .bool(fake.isEmpty ? Self.canReadHere(homeDir) == true : fake == "granted")] }
    public func openSettings() async -> JSONValue { ["opened": .bool(await open(Self.pane))] }
}

// MARK: providers.cjs

/// Which of Claude Code and Codex runs onboarding's agents (the rule is ImportFlow.chooseProvider). What is read, never a
/// token: installed / signed in from the tool check; Claude Code's `auth status --json` subscriptionType; Codex's plan from
/// its sign-in file's ID token; seniority from when the CLI's folder was made. ENGELBART_PROVIDERS_FAKE stands in.
public final class Providers: @unchecked Sendable {
    /// The tool check's record of a CLI (Tools package: manager snapshot()).
    public struct ToolRecord: Sendable { public var installed = false, status = "missing", signedIn: Bool? = nil, autoUpdate: Bool? = nil, path: String? = nil, account: String? = nil, error: String? = nil, busyAction: String? = nil
        public init(installed: Bool = false, status: String = "missing", signedIn: Bool? = nil, autoUpdate: Bool? = nil, path: String? = nil, account: String? = nil, error: String? = nil, busyAction: String? = nil) {
            self.installed = installed; self.status = status; self.signedIn = signedIn; self.autoUpdate = autoUpdate; self.path = path; self.account = account; self.error = error; self.busyAction = busyAction } }

    static let cacheMs = 60_000.0
    static let paid = "^(plus|pro|team|business|enterprise|edu|max)"
    static let toolOf = ["anthropic": "claude", "openai": "codex"]
    static let fakes: [String: [String: String?]] = ["both": ["anthropic": "max", "openai": "pro"], "claude": ["anthropic": "max", "openai": nil], "codex": ["anthropic": nil, "openai": "plus"], "free": ["anthropic": nil, "openai": nil]]

    /// Codex's plan from its sign-in file → its name, or nil (none, free, or no file).
    public static func codexPlan(codexHome: String) -> String? {
        guard let auth = Files.readJSON(URL(fileURLWithPath: (codexHome as NSString).appendingPathComponent("auth.json"))), let token = auth["tokens"]?["id_token"]?.string else { return nil }
        let parts = token.components(separatedBy: ".")
        guard parts.count > 1 else { return nil }
        var b64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64), let claims = try? JSONValue.parse(data), let plan = claims["https://api.openai.com/auth"]?["chatgpt_plan_type"]?.string,
              JS.test(plan, paid, options: .caseInsensitive) else { return nil }
        return String(plan.lowercased().prefix(24))
    }

    /// Claude Code's `auth status --json` text → (loggedIn, plan), or nil when unreadable.
    public static func claudeAuth(_ text: String) -> (loggedIn: Bool, plan: String?)? {
        guard let s = text.firstIndex(of: "{"), let e = text.lastIndex(of: "}"), s < e, let status = try? JSONValue.parse(String(text[s...e])), let logged = status["loggedIn"]?.bool else { return nil }
        if !logged { return (false, nil) }
        let method = status["authMethod"]?.string
        let sub = status["subscriptionType"]?.string ?? ""
        return (true, (method == nil || method == "claude.ai") && !sub.isEmpty ? String(sub.lowercased().prefix(24)) : nil)
    }

    public static func codexSignedIn(codexHome: String) -> Bool {
        guard let token = Files.readJSON(URL(fileURLWithPath: (codexHome as NSString).appendingPathComponent("auth.json")))?["tokens"]?["id_token"]?.string else { return false }
        return !token.isEmpty
    }

    /// Where a provider's CLI is, in the words the window shows (2026-10-14: "it should say connecting instead").
    public static func stateOf(_ r: ToolRecord, signedIn: Bool) -> String {
        if r.busyAction == "sign-in" { return "signing-in" }
        if ["install", "check", "update"].contains(r.busyAction ?? "") { return signedIn ? "ready" : "connecting" }
        if ["installing", "checking", "unknown"].contains(r.status) { return "connecting" }
        return signedIn ? "ready" : "not-connected"
    }

    public static func bornAt(_ dir: String) -> Double? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: dir) else { return nil }
        if let born = attrs[.creationDate] as? Date { return Time.ms(born) }
        return (attrs[.modificationDate] as? Date).map { Time.ms($0) }
    }

    let records: () -> [String: ToolRecord]
    let prefs: OnboardingPrefs
    let homeDir: String
    let env: [String: String]
    let fake: String
    let claudeStatus: (String) async -> String
    let check: (([String]) async -> Void)?
    let now: () -> Double
    var cache: (at: Double, providers: [JSONValue])?
    let lock = NSLock()

    public init(records: @escaping () -> [String: ToolRecord], prefs: OnboardingPrefs, homeDir: String, env: [String: String] = ProcessInfo.processInfo.environment, fake: String? = nil,
                claudeStatus: ((String) async -> String)? = nil, check: (([String]) async -> Void)? = nil, now: @escaping () -> Double = { Time.ms() }) {
        self.records = records; self.prefs = prefs; self.homeDir = homeDir; self.env = env; self.fake = fake ?? env["ENGELBART_PROVIDERS_FAKE"] ?? ""; self.check = check; self.now = now
        let environment = CLI.sanitizeEnvironment(CLI.scrubAgentSession(env))
        self.claudeStatus = claudeStatus ?? { path in ((try? await ProcessRunner.run(path, ["auth", "status", "--json"], environment: environment, timeout: 15))?.stdout) ?? "" }
    }

    var codexHome: String { env["CODEX_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? (homeDir as NSString).appendingPathComponent(".codex") }

    func read() async -> [JSONValue] {
        if !fake.isEmpty {
            if fake == "none" { return ["anthropic", "openai"].map { ["id": .string($0), "name": .string(ImportFlow.providerNames[$0]!), "installed": true, "signedIn": false, "subscription": .null, "subscribed": false, "since": .null, "state": "not-connected"] } }
            let plans = Self.fakes[fake] ?? Self.fakes["claude"]!
            return ["anthropic", "openai"].enumerated().map { n, id in
                let plan = plans[id] ?? nil
                return ["id": .string(id), "name": .string(ImportFlow.providerNames[id]!), "installed": true, "signedIn": true, "subscription": plan.map { .string($0) } ?? .null,
                        "subscribed": .bool(plan != nil), "since": .number(n == 0 ? 1_700_000_000_000 : 1_710_000_000_000), "state": "ready"]
            }
        }
        let snap = records()
        var out: [JSONValue] = []
        for id in ["anthropic", "openai"] {
            let r = snap[Self.toolOf[id]!] ?? ToolRecord()
            let installed = r.installed && r.busyAction != "install"
            let works = r.status == "ready" || r.status == "updating" || (r.status == "outdated" && r.autoUpdate == true)
            let asked = installed && (works || r.status == "outdated" || r.status == "incompatible")
            var cliSignedIn = asked && r.signedIn == true
            var subscription: String?
            if asked && id == "anthropic", let path = r.path, let auth = Self.claudeAuth(await claudeStatus(path)) { cliSignedIn = auth.loggedIn; subscription = auth.plan }
            if asked && id == "openai" {
                if r.signedIn == nil { cliSignedIn = Self.codexSignedIn(codexHome: codexHome) }
                if cliSignedIn { subscription = Self.codexPlan(codexHome: codexHome) }
            }
            let signedIn = works && cliSignedIn
            let since = Self.bornAt(id == "anthropic" ? (homeDir as NSString).appendingPathComponent(".claude") : codexHome)
            out.append(["id": .string(id), "name": .string(ImportFlow.providerNames[id]!), "installed": .bool(installed), "signedIn": .bool(signedIn), "subscription": subscription.map { .string($0) } ?? .null,
                        "subscribed": .bool(cliSignedIn && subscription != nil), "since": since.map { .number($0) } ?? .null, "account": r.account.map { .string($0) } ?? .null,
                        "status": .string(r.status), "state": .string(Self.stateOf(r, signedIn: signedIn)), "error": signedIn ? .null : (r.error.map { .string($0) } ?? .null)])
        }
        return out
    }

    func withDecision(_ providers: [JSONValue]) -> JSONValue {
        let remembered = prefs.get()["provider"]?.string
        let facts = providers.map { ImportFlow.ProviderFacts(id: JS.string($0["id"]), installed: $0["installed"] == .bool(true), signedIn: $0["signedIn"] == .bool(true), subscription: $0["subscription"]?.string, since: $0["since"]?.double) }
        let d = ImportFlow.chooseProvider(facts, remembered: remembered)
        var decision: [String: JSONValue] = ["pick": d.pick.map { .string($0) } ?? .null, "ask": .bool(d.ask), "choices": .array(d.choices.map { .string($0) }), "setup": .bool(d.setup)]
        if d.ask { decision["suggested"] = d.suggested.map { .string($0) } ?? .null }
        return ["providers": .array(providers), "decision": .object(decision), "remembered": remembered.map { .string($0) } ?? .null]
    }

    /// → { providers, decision, remembered } (a minute's cache; `fresh` reads again).
    public func status(fresh: Bool = false) async -> JSONValue {
        lock.lock()
        if !fresh, let c = cache, now() - c.at < Self.cacheMs { let p = c.providers; lock.unlock(); return withDecision(p) }
        lock.unlock()
        let providers = await read()
        lock.lock(); cache = (now(), providers); lock.unlock()
        return withDecision(providers)
    }

    public func remember(_ id: String) async throws -> JSONValue {
        guard Self.toolOf[id] != nil else { throw ConnectError("failed", "provider is invalid") }
        _ = try prefs.set(["provider": .string(id)])
        return await status()
    }

    public func forget() { lock.lock(); cache = nil; lock.unlock() }

    /// An agent on `id` failed as one that needs the person: its CLI checked again now.
    @discardableResult
    public func recheck(_ id: String) async -> JSONValue? {
        forget()
        guard let name = Self.toolOf[id], fake.isEmpty, let check else { return nil }
        await check([name])
        forget()
        return await status(fresh: true)
    }

    public func ready(_ id: String) async -> Bool {
        let out = await status(fresh: true)
        return (out["providers"]?.array ?? []).contains { $0["id"]?.string == id && $0["installed"] == .bool(true) && $0["signedIn"] == .bool(true) }
    }
}

// MARK: browsers.cjs

/// The browser whose sign-ins Engelbart uses: installed ones only, the default first; the person's pick and profile
/// remembered (OnboardingPrefs). Allow asks macOS for that browser's sign-ins at once. ENGELBART_ONBOARDING_BROWSERS stands in.
public final class Browsers: @unchecked Sendable {
    let installedCheck: ([String]) async -> [String: Bool]
    let defaultName: () -> String
    let prefs: OnboardingPrefs
    let override: [String]?
    let profilesOf: (String) -> [BrowserSource.Profile]
    let unlock: ((String) async -> JSONValue)?
    let diskAccess: (() -> Bool)?
    var last: (ids: [String], chosenId: String?)?
    let lock = NSLock()

    /// `installed(bundles)` → bundle → installed (the app's installed-apps lookup, bounded at 2.5 s).
    public init(installed: @escaping ([String]) async -> [String: Bool] = Browsers.lookUp, defaultName: @escaping () -> String = Browsers.macDefault, prefs: OnboardingPrefs,
                override: [String]? = ProcessInfo.processInfo.environment["ENGELBART_ONBOARDING_BROWSERS"].map { $0.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } },
                profilesOf: @escaping (String) -> [BrowserSource.Profile] = { _ in [] }, unlock: ((String) async -> JSONValue)? = nil, diskAccess: (() -> Bool)? = nil) {
        self.installedCheck = installed; self.defaultName = defaultName; self.prefs = prefs; self.override = override; self.profilesOf = profilesOf; self.unlock = unlock; self.diskAccess = diskAccess
    }

    public static let lookUp: ([String]) async -> [String: Bool] = { bundles in
        var out: [String: Bool] = [:]
        for b in bundles { out[b] = NSWorkspace.shared.urlForApplication(withBundleIdentifier: b) != nil }
        return out
    }
    public static let macDefault: () -> String = {
        guard let url = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "https://example.com")!) else { return "" }
        return FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
    }

    func defaultId() -> String? { override.map { $0.first } ?? ImportFlow.browserIdOfName(defaultName()) }

    func installed() async -> [String] {
        if let override { return override.filter { ImportFlow.browserById($0) != nil } }
        let answers = await installedCheck(ImportFlow.browsers.map(\.bundle))
        return ImportFlow.browsers.filter { answers[$0.bundle] == true }.map(\.id)
    }

    func profiles(_ id: String) -> [JSONValue] { profilesOf(id).map { ["id": .string($0.id), "name": .string($0.name.isEmpty ? $0.id : $0.name), "email": .string($0.email)] } }

    public func list() async -> JSONValue {
        let ids = ImportFlow.orderBrowsers(await installed(), defaultId: defaultId())
        let remembered = prefs.get()
        let rb = remembered["browser"]?.string
        let chosenId = rb.flatMap { ids.contains($0) ? $0 : nil } ?? ids.first
        lock.lock(); last = (ids, chosenId); lock.unlock()
        let browsers: [JSONValue] = ids.map { id in
            let b = ImportFlow.browserById(id)!
            return ["id": .string(b.id), "name": .string(b.name), "bundle": .string(b.bundle), "keychain": .bool(b.keychain), "isDefault": .bool(id == defaultId()), "profiles": .array(profiles(id))]
        }
        let chosenProfiles = chosenId.map { profiles($0) } ?? []
        let rp = remembered["profile"]?.string
        let chosenProfile = rp.flatMap { p in (rb == nil || rb == chosenId) && chosenProfiles.contains { $0["id"]?.string == p } ? p : nil }
        return ["browsers": .array(browsers), "defaultId": defaultId().map { .string($0) } ?? .null, "chosenId": chosenId.map { .string($0) } ?? .null,
                "chosenProfile": chosenProfile.map { .string($0) } ?? .null, "keychain": remembered["keychain"] ?? .null, "safari": ["diskAccess": .bool(diskAccess?() ?? false)]]
    }

    func knownIds() async -> [String] { lock.lock(); let l = last; lock.unlock(); if let l { return l.ids }; return (await list())["browsers"]?.array?.compactMap { $0["id"]?.string } ?? [] }

    public func choose(_ id: String) async throws -> JSONValue {
        guard let b = ImportFlow.browserById(id) else { throw ConnectError("failed", "browser is invalid") }
        if !(await knownIds()).contains(id) { throw ConnectError("failed", "\(b.name) is not installed") }
        let was = prefs.get()["browser"]?.string
        var patch: [String: JSONValue] = ["browser": .string(id)]
        if was != id { patch["profile"] = .null }
        _ = try prefs.set(patch)
        return await list()
    }

    public func chooseProfile(_ browserId: String, _ profileId: String) async throws -> JSONValue {
        guard let b = ImportFlow.browserById(browserId) else { throw ConnectError("failed", "browser is invalid") }
        if !(await knownIds()).contains(browserId) { throw ConnectError("failed", "\(b.name) is not installed") }
        if !profiles(browserId).contains(where: { $0["id"]?.string == profileId }) { throw ConnectError("failed", "\(b.name) has no such profile") }
        _ = try prefs.set(["browser": .string(browserId), "profile": .string(profileId)])
        return await list()
    }

    /// The answer to "Allow Engelbart to use your <browser> sign-ins?", remembered; allowed → macOS asked at once.
    public func setKeychain(_ answer: String) async throws -> JSONValue {
        guard answer == "allowed" || answer == "declined" else { throw ConnectError("failed", "answer is invalid") }
        _ = try prefs.set(["keychain": .string(answer)])
        if answer == "declined" || unlock == nil { return ["keychain": .string(answer)] }
        lock.lock(); let chosen = last?.chosenId; lock.unlock()
        guard let id = prefs.get()["browser"]?.string ?? chosen ?? defaultId() else { return ["keychain": "allowed"] }
        let out = await unlock!(id)
        if out["keychain"]?.string == "refused" {
            var o: [String: JSONValue] = ["keychain": "refused", "browser": .string(out["browser"]?.string ?? ImportFlow.browserById(id)?.name ?? "")]
            if let needs = out["needs"] { o["needs"] = needs }
            return .object(o)
        }
        return ["keychain": "allowed"]
    }

    /// The name web-signin should treat as the default browser.
    public func preferredName() -> String {
        if let b = prefs.get()["browser"]?.string, let found = ImportFlow.browserById(b) { return found.name }
        lock.lock(); let chosen = last?.chosenId; lock.unlock()
        if let chosen, let found = ImportFlow.browserById(chosen) { return found.name }
        return defaultName()
    }
}

// MARK: obsidian-tree.cjs

/// Obsidian's vaults as its file explorer shows them (2026-10-14), for Choose files under Obsidian.
public enum ObsidianTree {
    static let shown = #"\.(md|canvas|pdf|png|jpe?g|gif|svg|webp|txt|csv)$"#
    public static func tree(homeDir: String, maxEntries: Int = 5000) -> JSONValue {
        var seen = 0
        var truncated = false
        func read(_ dir: String, _ depth: Int) -> [JSONValue] {
            if depth > 10 { return [] }
            guard let entries = Readers.entries(dir) else { return [] }
            var folders: [(String, String)] = [], files: [(String, String)] = []
            for e in entries {
                if e.name.hasPrefix(".") || e.name == "node_modules" { continue }
                if seen >= maxEntries { truncated = true; break }
                let full = (dir as NSString).appendingPathComponent(e.name)
                if e.isDir { seen += 1; folders.append((e.name, full)) }
                else if e.isFile && JS.test(e.name, shown, options: .caseInsensitive) { seen += 1; files.append((JS.replace(e.name, #"\.md$"#, "", options: .caseInsensitive), full)) }
            }
            let byName = { (a: (String, String), b: (String, String)) in a.0.localizedStandardCompare(b.0) == .orderedAscending }
            folders.sort(by: byName); files.sort(by: byName)
            return folders.map { ["name": .string($0.0), "path": .string($0.1), "dir": true, "children": .array(read($0.1, depth + 1))] } + files.map { ["name": .string($0.0), "path": .string($0.1), "dir": false] }
        }
        let vaults: [JSONValue] = Readers.obsidianVaults(homeDir).map { ["name": .string($0.name), "path": .string($0.path), "tree": .array(read($0.path, 0))] }
        return ["vaults": .array(vaults), "truncated": .bool(truncated)]
    }
}

// MARK: digest.cjs

public enum Digest {
    public static let days = 120.0
    static let repoSkip: Set<String> = ["Library", "Applications", "Pictures", "Movies", "Music", "Public", "node_modules"]
    static let guarded: Set<String> = ["Desktop", "Documents", "Downloads"]

    /// The git repositories in the home folder worked on lately (up to `depth` folders down).
    public static func recentRepos(homeDir: String, days: Double = Digest.days, access: FolderAccess.Guard? = nil, max: Int = 15, depth: Int = 3, now: Double = Time.ms()) -> [JSONValue] {
        let since = now - days * 86_400_000
        var found: [(String, Double)] = []
        var level = [homeDir]
        for _ in 0..<depth where !level.isEmpty {
            var next: [String] = []
            for dir in level {
                for e in (Readers.entries(dir) ?? []).sorted(by: { $0.name < $1.name }) where e.isDir && !e.name.hasPrefix(".") && !repoSkip.contains(e.name) {
                    let full = (dir as NSString).appendingPathComponent(e.name)
                    if dir == homeDir && guarded.contains(e.name) && !(access?.readable(full) ?? false) { continue }
                    if let access, !access.readable(full) { continue }
                    var stamp = 0.0
                    for part in ["logs/HEAD", "index", "HEAD"] { stamp = Swift.max(stamp, Readers.statOf((full as NSString).appendingPathComponent(".git/\(part)"))?.mtimeMs ?? 0) }
                    if stamp > 0 { if stamp >= since { found.append((full, stamp)) }; continue }
                    next.append(full)
                }
            }
            level = Array(next.prefix(400))
        }
        return found.sorted { $0.1 > $1.1 }.prefix(max).map { full, stamp in
            var readme = ""
            for name in ["README.md", "readme.md", "README"] {
                if let text = try? String(contentsOfFile: (full as NSString).appendingPathComponent(name), encoding: .utf8) {
                    readme = String(JS.replace(text.components(separatedBy: .newlines).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? "", #"^#+\s*"#, "").trimmingCharacters(in: .whitespaces).prefix(120))
                    break
                }
            }
            var o: [String: JSONValue] = ["shown": .string(Readers.shownPath(homeDir, full)), "path": .string(full), "name": .string((full as NSString).lastPathComponent),
                                          "last": .string(String(Time.iso(Date(timeIntervalSince1970: stamp / 1000)).prefix(10)))]
            if !readme.isEmpty { o["readme"] = .string(readme) }
            return .object(o)
        }
    }

    /// What the person worked on lately, read without a model → { folders, repos, projects }.
    public static func projectDigest(homeDir: String, env: [String: String] = ProcessInfo.processInfo.environment, access: FolderAccess.Guard? = nil, existing: [String] = [], days: Double = Digest.days) -> JSONValue {
        struct Folder { var shown: String; var sessions = 0; var last = ""; var apps: [String] = []; var titles: [String] = [] }
        var byFolder: [String: Folder] = [:]
        for app in ["Claude Code", "Codex"] {
            for chat in Readers.localChats(app, homeDir: homeDir, env: env, days: days, limit: 400) {
                let key = chat.project.isEmpty ? "(no folder)" : chat.project
                var f = byFolder[key] ?? Folder(shown: key)
                f.sessions += 1
                if !f.apps.contains(app) { f.apps.append(app) }
                if let d = chat.date, d > f.last { f.last = d }
                if f.titles.count < 10 && !chat.title.isEmpty && !f.titles.contains(chat.title) { f.titles.append(chat.title) }
                byFolder[key] = f
            }
        }
        let repos = Scan.localRepos(homeDir: homeDir, env: env, access: access)
        let repoOf = { (shown: String) in repos.first { shown == $0.shown || shown.hasPrefix("\($0.shown)/") } }
        let folders: [(JSONValue, String, Int)] = byFolder.values.map { f in
            let full = f.shown.hasPrefix("~") ? homeDir + f.shown.dropFirst() : f.shown
            let name = (full as NSString).lastPathComponent
            let last = String(f.last.prefix(10))
            return (["shown": .string(f.shown), "path": .string(full.hasPrefix("/") ? full : ""), "name": .string(name.isEmpty ? f.shown : name), "sessions": .number(Double(f.sessions)),
                     "last": .string(last), "apps": .array(f.apps.map { .string($0) }), "repository": repoOf(f.shown).map { .string($0.shown) } ?? .null, "titles": .array(f.titles.map { .string($0) })], last, f.sessions)
        }.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.2 > $1.2 }
        let kept = folders.prefix(25).map(\.0)
        let recent = recentRepos(homeDir: homeDir, days: days, access: access).filter { r in !kept.contains { $0["repository"] == r["shown"] || $0["shown"] == r["shown"] } }
        return ["folders": .array(Array(kept)), "repos": .array(recent), "projects": .array(existing.prefix(30).map { .string($0) })]
    }

    public static func digestEmpty(_ digest: JSONValue?) -> Bool { (digest?["folders"]?.array ?? []).isEmpty && (digest?["repos"]?.array ?? []).isEmpty }
}
