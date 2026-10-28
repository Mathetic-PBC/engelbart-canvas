import Foundation
import EngelbartCore

// Port of src/main/connect/scan.cjs (Connect your library, 2026-10-07): what Engelbart finds before anyone asks. `detect`
// is the choose screen's: which apps are here, so it starts with those ticked. `scanFor` is the librarian's first look at
// what the person picked on this Mac, so its questions can be about their own things ("You have 14 Zotero collections:
// …"). An app on the web or behind a connector is not read here: a survey agent looks at it. Both only read.

/// The sign-ins the scan asks about (Integrations owns Zotero and GitHub; the app adapts them).
public struct ZoteroStatus: Sendable, Equatable { public var connected: Bool; public var username: String?
    public init(connected: Bool, username: String? = nil) { self.connected = connected; self.username = username } }
public struct GitHubStatus: Sendable, Equatable { public var connected: Bool; public var login: String?
    public init(connected: Bool, login: String? = nil) { self.connected = connected; self.login = login } }
public struct GitHubRepos: Sendable { public var repos: [String]; public var missingOrgs: [(login: String, repos: Int)]
    public init(repos: [String], missingOrgs: [(login: String, repos: Int)] = []) { self.repos = repos; self.missingOrgs = missingOrgs } }

public struct ScanZotero: Sendable {
    public var status: @Sendable () -> ZoteroStatus?
    /// The mirror's folder (items.json, collections.json), nil until its first sync.
    public var root: @Sendable () -> String?
    public init(status: @escaping @Sendable () -> ZoteroStatus?, root: @escaping @Sendable () -> String?) { self.status = status; self.root = root }
    public static let none = ScanZotero(status: { nil }, root: { nil })
}

public struct ScanGitHub: Sendable {
    public var status: @Sendable () -> GitHubStatus?
    public var repos: (@Sendable (_ dirs: [String]) async throws -> GitHubRepos)?
    public init(status: @escaping @Sendable () -> GitHubStatus?, repos: (@Sendable ([String]) async throws -> GitHubRepos)? = nil) { self.status = status; self.repos = repos }
    public static let none = ScanGitHub(status: { nil })
}

public enum Scan {
    static func exists(_ p: String) -> Bool { Readers.exists(p) }
    static func join(_ a: String, _ b: String) -> String { (a as NSString).appendingPathComponent(b) }

    public static func googleDrives(_ homeDir: String) -> [String] {
        let base = join(homeDir, "Library/CloudStorage")
        return ((try? FileManager.default.contentsOfDirectory(atPath: base)) ?? []).sorted().filter { $0.hasPrefix("GoogleDrive-") }.map { join(base, $0) }
    }

    // An app installed on this Mac (its bundle in /Applications or ~/Applications) counts as found: the person uses it.
    public static let bundles: [String: [String]] = ["ChatGPT": ["ChatGPT.app"], "Claude": ["Claude.app"], "Granola": ["Granola.app"], "Notion": ["Notion.app"],
                                                     "Evernote": ["Evernote.app"], "OneNote": ["Microsoft OneNote.app"], "Perplexity": ["Perplexity.app"], "Cursor": ["Cursor.app"],
                                                     "Zoom": ["zoom.us.app"], "Obsidian": ["Obsidian.app"], "Google Docs": ["Google Drive.app"], "Zotero": ["Zotero.app"]]
    static func installed(_ app: String, _ roots: [String]) -> Bool { (bundles[app] ?? []).contains { b in roots.contains { exists(join($0, b)) } } }

    public struct Found: Sendable, Equatable { public var found: Bool; public var `where`: String; public var signedIn: Bool?
        public var json: JSONValue { var o: [String: JSONValue] = ["found": .bool(found), "where": .string(`where`)]; if let signedIn { o["signedIn"] = .bool(signedIn) }; return .object(o) } }

    public struct Repo: Sendable, Equatable { public var path: String; public var shown: String; public var name: String; public var sessions: Int; public var checked: Bool
        public var json: JSONValue { ["path": .string(path), "shown": .string(shown), "name": .string(name), "sessions": .number(Double(sessions)), "checked": .bool(checked)] } }

    public struct Detected: Sendable {
        public var apps: [String: Found]
        public var sites: Found
        public var github: Found
        public var localRepos: Result<[Repo], ConnectError>
        public var json: JSONValue {
            let repos: JSONValue
            switch localRepos { case .success(let r): repos = .array(r.map(\.json)); case .failure(let e): repos = ["error": .string(e.message)] }
            return ["apps": .object(apps.mapValues(\.json)), "sites": sites.json, "github": github.json, "localRepos": repos]
        }
    }

    /// Which apps are on this Mac. `signedIn`: the apps Engelbart's browser holds a sign-in for (counted as found too).
    /// `connectors(app)`: whether Engelbart is signed in to an app's connector.
    public static func detect(homeDir: String, env: [String: String] = ProcessInfo.processInfo.environment, zotero: ZoteroStatus? = nil, github: GitHubStatus? = nil,
                              signedIn: [String] = [], connectors: (String) -> Bool = { _ in false }, applications: [String]? = nil, access: FolderAccess.Guard? = nil) -> Detected {
        let applications = applications ?? ["/Applications", join(homeDir, "Applications")]
        var apps: [String: Found] = [:]
        func set(_ app: String, _ found: Bool, _ where_: String = "") { apps[app] = Found(found: found, where: where_, signedIn: nil) }
        let has = { (app: String) in installed(app, applications) }
        let web = Set(signedIn)
        let vaults = Readers.obsidianVaults(homeDir)
        set("Obsidian", !vaults.isEmpty, vaults.map(\.shown).joined(separator: ", "))
        set("Claude Code", exists(join(homeDir, ".claude/projects")), "~/.claude/projects")
        let codex = Readers.codexRoot(homeDir, env)
        set("Codex", exists(codex), Readers.shownPath(homeDir, codex))
        set("Cursor", exists(Cursor.dbPath(homeDir: homeDir)), "its chats on this Mac")
        let zoom = join(homeDir, "Documents/Zoom")
        set("Zoom", exists(zoom), exists(zoom) ? "~/Documents/Zoom" : "")
        set("Google Docs", !googleDrives(homeDir).isEmpty || web.contains("Google Docs") || has("Google Docs"), web.contains("Google Docs") ? "signed in to Engelbart" : "Sign in to add")
        apps["Google Docs"]!.signedIn = web.contains("Google Docs")
        // Gmail: the same Google sign-in, read only in Engelbart's browser (no desktop app, no Drive folders).
        set("Gmail", web.contains("Gmail"), web.contains("Gmail") ? "signed in to Engelbart" : "Sign in to add")
        apps["Gmail"]!.signedIn = web.contains("Gmail")
        let zs = zotero ?? ZoteroStatus(connected: false)
        let zoteroDir = exists(join(homeDir, "Zotero"))
        set("Zotero", zs.connected || zoteroDir, zs.connected ? "signed in\((zs.username ?? "").isEmpty ? "" : " as \(zs.username!)")" : (zoteroDir ? "~/Zotero (sign in to read it)" : ""))
        // Only whether the folders are there: reading inside Downloads or Documents is left to the scan, after the person picked.
        let roots = Readers.pdfRoots(homeDir).map { ($0 as NSString).lastPathComponent }
        set(ConnectSources.localPDFs, !roots.isEmpty, roots.prefix(3).joined(separator: ", "))
        for app in ConnectSources.appOrder where apps[app] == nil && app != "GitHub" {
            let reach = ConnectSources.apps[app]!.reach
            if reach == .connector { let on = connectors(app); set(app, on || has(app), on ? "connected" : has(app) ? "on this Mac" : ""); continue }
            if reach == .automation { set(app, false, "on this Mac"); continue } // macOS asks first, so only when ticked
            // Found because its desktop app is installed is not the same as reachable (MATH-114: "Sign in to add").
            set(app, web.contains(app) || has(app), web.contains(app) ? "signed in to Engelbart" : has(app) ? "Sign in to add" : "")
            apps[app]!.signedIn = web.contains(app)
        }
        let profiles = Readers.browserProfiles(homeDir)
        var browsers: [String] = []
        for p in profiles where !browsers.contains(p.browser) { browsers.append(p.browser) }
        let gs = github ?? GitHubStatus(connected: false)
        return Detected(apps: apps, sites: Found(found: !profiles.isEmpty, where: browsers.joined(separator: ", "), signedIn: nil),
                        github: Found(found: gs.connected, where: gs.connected ? "signed in\((gs.login ?? "").isEmpty ? "" : " as \(gs.login!)")" : "", signedIn: nil),
                        localRepos: .success(localRepos(homeDir: homeDir, env: env, access: access)))
    }

    // The folders macOS keeps behind a prompt: nothing inside them is touched before the person picks (MATH-114).
    static let protected = ["Documents", "Desktop", "Downloads", "Library/Mobile Documents"]

    /// The repositories on this Mac found before any folder is picked (MATH-114): the folders Claude Code and Codex
    /// sessions were run in, grouped, with how many sessions each.
    public static func localRepos(homeDir: String, env: [String: String] = ProcessInfo.processInfo.environment, limit: Int = 2000, max: Int = 40, access: FolderAccess.Guard? = nil) -> [Repo] {
        let home = FolderAccess.resolve(homeDir)
        let inside = { (dir: String, root: String) in dir == root || dir.hasPrefix(root + "/") }
        let guarded = protected.map { join(home, $0) }
        var byFolder: [String: Int] = [:]
        var order: [String] = []
        for app in ["Claude Code", "Codex"] {
            for chat in Readers.localChats(app, homeDir: homeDir, env: env, limit: limit) {
                let dir = chat.project.hasPrefix("~") ? home + chat.project.dropFirst() : chat.project
                guard dir.hasPrefix("/") else { continue }
                let r = FolderAccess.resolve(dir)
                if byFolder[r] == nil { order.append(r) }
                byFolder[r, default: 0] += 1
            }
        }
        var repos: [String: Repo] = [:]
        var repoOrder: [String] = []
        for dir in order {
            let sessions = byFolder[dir]!
            if inside(dir, home) ? (dir == home || String(dir.dropFirst(home.count + 1)).hasPrefix(".")) : JS.test(dir, "^/(private|tmp|var)(/|$)") { continue }
            var root: String?
            var checked = true
            if guarded.contains(where: { inside(dir, $0) }) && !(access?.readable(dir) ?? false) {
                if guarded.contains(dir) { continue } // ~/Desktop itself is not a repository
                root = dir
                checked = false
            } else {
                var at = dir
                var up = 0
                while up < 8 && at != home && at != (at as NSString).deletingLastPathComponent {
                    if exists(join(at, ".git")) { root = at; break }
                    at = (at as NSString).deletingLastPathComponent
                    up += 1
                }
            }
            guard let root else { continue }
            if repos[root] == nil { repos[root] = Repo(path: root, shown: Readers.shownPath(homeDir, root), name: (root as NSString).lastPathComponent, sessions: 0, checked: checked); repoOrder.append(root) }
            repos[root]!.sessions += sessions
        }
        return repoOrder.compactMap { repos[$0] }.sorted { $0.sessions != $1.sessions ? $0.sessions > $1.sessions : $0.name.localizedCompare($1.name) == .orderedAscending }.prefix(max).map { $0 }
    }

    static func safely(_ work: () throws -> JSONValue) -> JSONValue {
        do { return try work() } catch { return ["error": .string((error as? ConnectError)?.message ?? error.localizedDescription)] }
    }

    static func count(_ n: Int, cap: Int = 400) -> JSONValue { n >= cap ? .string("\(cap)+") : .number(Double(n)) }

    /// A chat app on this Mac at a glance: counts, and the most recent titles (runs a program started left out).
    public static func chatsAtAGlance(_ app: String, homeDir: String, env: [String: String], days: Double?) -> JSONValue {
        if app == "Cursor" {
            return safely {
                let recent = try Cursor.chats(homeDir: homeDir, limit: 400)
                var o: [String: JSONValue] = ["reach": "local", "chats": count(recent.count),
                                              "recent": .array(recent.prefix(20).map { .string("\(($0.date ?? "").prefix(10)) \($0.title)") })]
                if let days { o["inPeriod"] = count(try Cursor.chats(homeDir: homeDir, days: days, limit: 400).count) }
                return .object(o)
            }
        }
        return safely {
            let recent = Readers.localChats(app, homeDir: homeDir, env: env, limit: 400)
            var byProject: [String: Int] = [:]
            var order: [String] = []
            for chat in recent { let k = chat.project.isEmpty ? "(no folder)" : chat.project; if byProject[k] == nil { order.append(k) }; byProject[k, default: 0] += 1 }
            var o = Readers.localChatCounts(app, homeDir: homeDir, env: env, days: days)
            o["reach"] = "local"
            o["typedByYou"] = count(recent.count)
            o["folders"] = .array(order.enumerated().sorted { byProject[$0.element]! != byProject[$1.element]! ? byProject[$0.element]! > byProject[$1.element]! : $0.offset < $1.offset }.prefix(15).map { .string("\($0.element) (\(byProject[$0.element]!))") })
            o["recent"] = .array(recent.prefix(20).map { .string("\(($0.date ?? "").prefix(10)) \($0.title)") })
            return .object(o)
        }
    }

    /// A folder at a glance, cut down for the librarian.
    public static func folderAtAGlance(_ dir: String, homeDir: String) -> JSONValue {
        let o = Readers.folderOverview(dir, homeDir: homeDir, top: 25)
        let folders: [JSONValue] = (o["folders"]?.array ?? []).map { e in
            let pdfs = e["pdfs"]?.double ?? 0, images = e["images"]?.double ?? 0, dated = e["dated"]?.double ?? 0
            return .string("\(JS.string(e["name"])): \(JS.string(e["notes"])) notes\(pdfs > 0 ? ", \(JS.number(pdfs)) pdfs" : "")\(images > 0 ? ", \(JS.number(images)) pictures" : "")\(dated >= 0.6 ? ", mostly dated" : "")")
        }
        let daily = o["dailyFolder"]?.string ?? ""
        return ["folder": o["shown"] ?? .null, "notes": o["notes"] ?? .null, "pdfs": o["pdfs"] ?? .null, "images": o["images"] ?? .null, "newest": o["newest"] ?? .null,
                "notesAtTop": o["rootNotes"] ?? .null, "dailyNotesFolder": daily.isEmpty ? .null : .string(daily), "folders": .array(folders),
                "moreFolders": o["moreFolders"] ?? .null, "truncated": o["truncated"] ?? .null]
    }

    /// The PDFs on this Mac at a glance, by folder, for the librarian to ask about folders and kinds of papers.
    public static func pdfsAtAGlance(_ chosen: [String], homeDir: String, everywhere: Bool, project: (name: String, description: String)? = nil, days: Double? = nil, access: FolderAccess.Guard? = nil) -> JSONValue {
        let guardian = access ?? FolderAccess.guardFor(homeDir: homeDir, answers: [:], picked: chosen)
        let roots = chosen.filter { guardian.readable($0) } + (everywhere ? Readers.pdfRoots(homeDir, readable: guardian.readable) : [])
        let notAllowed = everywhere ? guardian.blocked.map(\.name) : []
        var left: [String: JSONValue] = [:]
        if !notAllowed.isEmpty {
            left = ["notAllowed": .array(notAllowed.map { .string($0) }),
                    "notAllowedAre": "macOS has not let Engelbart read these folders: they were not looked in. The person can allow them in System Settings → Privacy & Security → Files and Folders."]
        }
        if roots.isEmpty { return .object(["reach": "local", "needs": "folder"].merging(left) { a, _ in a }) }
        let found = Readers.pdfFolders(roots, homeDir: homeDir, project: project, days: days, readable: guardian.readable)
        var o: [String: JSONValue] = ["reach": "local", "lookedIn": found["roots"] ?? .null, "pdfs": found["pdfs"] ?? .null, "folders": found["folders"] ?? .null,
                                      "moreFolders": found["moreFolders"] ?? .null, "truncated": found["truncated"] ?? .null]
        o.merge(left) { a, _ in a }
        if let days {
            o["period"] = .string("Counts and examples cover only the PDFs changed in \(ConnectSources.periodName(Int(days))); olderLeftOut says how many older ones were left out.")
            o["olderLeftOut"] = found["olderLeftOut"] ?? .null
            if let older = found["olderRelated"]?.array, !older.isEmpty {
                o["olderRelated"] = .array(older)
                o["olderRelatedAre"] = "Older than the period, sharing words with the project: offer them by title, say they are older, and ask first."
            }
        }
        if project != nil { o["examplesFirst"] = "Each folder's examples begin with the PDFs whose name or title shares words with the project (relatedToProject counts them), then the newest." }
        o["kinds"] = "A guess from each file's name: paper, book (books, slides, lecture notes), personal (receipts, statements, tickets: never offered or brought in), unclear (judge from the titles)."
        return .object(o)
    }

    /// What the librarian is shown about each app the person picked → { [source]: { [app]: evidence } }. `choices` as the
    /// session keeps them (sources, project, days, permissions, picked); `picked` the folders chosen with the chat's buttons.
    public static func scanFor(_ choices: JSONValue, homeDir: String, env: [String: String] = ProcessInfo.processInfo.environment, picked: [String: String] = [:],
                               zotero: ScanZotero = .none, github: ScanGitHub = .none, appleNotes: AppleNotes? = nil, access: FolderAccess.Guard? = nil) async -> JSONValue {
        var out: [String: JSONValue] = [:]
        let guardian = access ?? FolderAccess.guardFor(homeDir: homeDir, answers: [:], picked: (choices["picked"]?.array ?? []).map { JS.string($0) })
        let days = choices["days"]?.double
        let project: (name: String, description: String)? = JS.truthy(choices["project"]) ? (JS.string(choices["project"]?["name"]), JS.string(choices["project"]?["description"])) : nil
        let cloud: JSONValue = "Cloud recordings can be read at zoom.us in Engelbart's browser."
        for id in ConnectSources.sourceIds {
            guard let choice = choices["sources"]?[id], JS.truthy(choice["on"]) else { continue }
            var here: [String: JSONValue] = [:]
            let apps = (choice["apps"]?.array ?? []).map { JS.string($0) }
            let chosenFolders = (choice["folders"]?.array ?? []).map { JS.string($0) }
            for app in apps {
                guard let info = ConnectSources.apps[app] else { continue }
                let reach: JSONValue = .string(info.reach.rawValue)
                if app == "Obsidian" {
                    let vaults: [(path: String, shown: String)] = picked["Obsidian"].map { [($0, Readers.shownPath(homeDir, $0))] } ?? Readers.obsidianVaults(homeDir).map { ($0.path, $0.shown) }
                    if vaults.isEmpty { here[app] = ["reach": reach, "needs": "folder"] } else {
                        here[app] = ["reach": reach, "vaults": .array(vaults.prefix(4).map { v in
                            var g = folderAtAGlance(v.path, homeDir: homeDir).object ?? [:]
                            g["linksInNotes"] = .number(Double(Readers.linksIn(v.path, limit: 400).count))
                            return .object(g)
                        })]
                    }
                } else if app == "Zotero" {
                    let status = zotero.status()
                    let root = zotero.root()
                    if status?.connected != true { here[app] = ["reach": reach, "needs": "signin"] }
                    else if root == nil { here[app] = ["reach": reach, "signedIn": true, "syncing": true] }
                    else {
                        here[app] = safely {
                            let c = try Readers.zoteroCollections(root!)
                            return ["reach": reach, "signedIn": true, "items": .number(Double(c.items)), "unfiled": .number(Double(c.unfiled)),
                                    "collections": .array(c.collections.prefix(60).map { .string("\($0.path) (\($0.items)) [key \($0.key)]") }),
                                    "moreCollections": .number(Double(Swift.max(0, c.collections.count - 60)))]
                        }
                    }
                } else if ["Claude Code", "Codex", "Cursor"].contains(app) {
                    here[app] = chatsAtAGlance(app, homeDir: homeDir, env: env, days: JS.truthy(choices["days"]) ? days : nil)
                } else if app == "Zoom" {
                    let dir = picked["Zoom"] ?? join(homeDir, "Documents/Zoom")
                    if exists(dir) { var g = folderAtAGlance(dir, homeDir: homeDir).object ?? [:]; g["reach"] = reach; g["cloud"] = cloud; here[app] = .object(g) }
                    else { here[app] = ["reach": reach, "needs": "folder", "cloud": cloud] }
                } else if app == ConnectSources.localPDFs {
                    here[app] = pdfsAtAGlance(chosenFolders + [picked[ConnectSources.localPDFs]].compactMap { $0 }, homeDir: homeDir,
                                              everywhere: JS.truthy(choices["permissions"]?["files"]), project: project, days: JS.truthy(choices["days"]) ? days : nil, access: guardian)
                } else if info.reach == .automation {
                    if let appleNotes {
                        do {
                            let folders = (try await appleNotes.folders()).array ?? []
                            here[app] = ["reach": reach, "folders": .array(folders.prefix(40).map { f in
                                let account = JS.string(f["account"])
                                return .string("\(JS.string(f["name"])) (\(JS.string(f["count"])))\(!account.isEmpty && account != "iCloud" ? " · \(account)" : "") [id \(JS.string(f["id"]))]")
                            })]
                        } catch { here[app] = ["error": .string((error as? ConnectError)?.message ?? error.localizedDescription)] }
                    } else { here[app] = ["reach": reach, "needs": "permission"] }
                } else {
                    here[app] = ["reach": reach] // web or connector: its survey reads it
                }
            }
            if id == "sites" {
                let profiles = Readers.browserProfiles(homeDir)
                here["browsers"] = .array(profiles.prefix(8).map { .string("\($0.browser) · \($0.name)\($0.used.map { " (last used \($0.prefix(10)))" } ?? "")") })
                if let first = profiles.first {
                    here["bookmarks"] = .number(Double(Readers.browserBookmarks(first.dir).count))
                    do { here["topSites"] = .array(try Readers.browserHistory(first.dir, days: 90, limit: 25).map { .string("\(JS.string($0["host"])) (\(JS.string($0["visits"])))") }) }
                    catch { here["topSites"] = ["error": .string((error as? ConnectError)?.message ?? error.localizedDescription)] }
                }
                let vaults = Readers.obsidianVaults(homeDir)
                if !vaults.isEmpty { here["linksInObsidian"] = .array(vaults.prefix(2).map { ["vault": .string($0.shown), "links": .number(Double(Readers.linksIn($0.path, limit: 400).count))] }) }
                if let dir = picked["sites"] { here["folder"] = folderAtAGlance(dir, homeDir: homeDir) }
            }
            if id == "papers" && !chosenFolders.isEmpty && !apps.contains(ConnectSources.localPDFs) {
                here["folders"] = pdfsAtAGlance(chosenFolders, homeDir: homeDir, everywhere: false, project: project, days: JS.truthy(choices["days"]) ? days : nil, access: guardian)
            }
            if id == "code" {
                // MATH-110: a repository under a protected folder macOS did not let Engelbart read is not looked into.
                let pickedRepos = chosenFolders.map { dir in guardian.readable(dir) ? (dir: dir, repos: gitFolders(dir), notAllowed: false) : (dir: dir, repos: [], notAllowed: true) }
                if github.status()?.connected == true, let repos = github.repos {
                    do {
                        let value = try await repos(pickedRepos.flatMap(\.repos))
                        here["github"] = ["signedIn": true, "repos": .array(value.repos.prefix(60).map { .string($0) }),
                                          "missingOrgs": .array(value.missingOrgs.prefix(12).map { ["login": .string($0.login), "repos": .number(Double($0.repos))] })]
                    } catch { here["github"] = ["error": .string(error.localizedDescription)] }
                } else { here["github"] = ["needs": "signin"] }
                if let r = choice["repos"]?.array, !r.isEmpty { here["picked"] = .array(r) }
                if !pickedRepos.isEmpty {
                    here["folders"] = .array(pickedRepos.map { e in
                        var o: [String: JSONValue] = ["folder": .string(Readers.shownPath(homeDir, e.dir)), "repositories": .array(e.repos.map { .string(Readers.shownPath(homeDir, $0)) })]
                        if e.notAllowed { o["notAllowed"] = "macOS has not let Engelbart read the folder this is in, so it was not looked into." }
                        return .object(o)
                    })
                }
            }
            out[id] = .object(here)
        }
        return .object(out)
    }

    /// The git repositories in a folder: it, or its folders two levels down that hold a .git.
    public static func gitFolders(_ dir: String, depth: Int = 2) -> [String] {
        if exists(join(dir, ".git")) { return [dir] }
        if depth <= 0 { return [] }
        guard let list = Readers.entries(dir) else { return [] }
        return Array(list.filter { $0.isDir && !$0.name.hasPrefix(".") && $0.name != "node_modules" }.sorted { $0.name < $1.name }
            .flatMap { gitFolders(join(dir, $0.name), depth: depth - 1) }.prefix(100))
    }
}
