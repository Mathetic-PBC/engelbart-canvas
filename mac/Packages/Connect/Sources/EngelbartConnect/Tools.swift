import Foundation
import EngelbartCore

// Port of src/main/connect/tools.cjs (Connect your library, 2026-10-07): the tools an import agent is given, served as the
// MCP server `engelbart` (ImportMCP, `--mcp import`) over the loopback bridge (ToolBridge), one bridge per import. They only
// ever write into the data root the session started in: Markdown files of the library's own in <data root>/assets/md and
// library rows. Nothing the person has is changed, moved or deleted. What has been brought in is remembered in
// <data root>/.connect/imported.json, so a second import of the same thing is skipped.

/// The job's browser as the tools drive it (AgentBrowser's tools(job)).
public protocol AgentPage: AnyObject, Sendable {
    func open(_ url: String) async throws -> JSONValue
    func ensure(_ url: String) async throws -> JSONValue
    func read(offset: Int, maxChars: Int) async throws -> JSONValue
    func click(_ ref: String) async throws -> JSONValue
    func type(_ ref: String, _ text: String, submit: Bool, replace: Bool) async throws -> JSONValue
    func press(_ key: String) async throws -> JSONValue
    func scroll(ref: String, direction: String, amount: Double) async throws -> JSONValue
    func wait(seconds: Double, untilText: String, untilGone: String, stable: Bool) async throws -> JSONValue
    func screenshot() async throws -> (data: String, mimeType: String)
    /// A fixed script of Engelbart's (web-chats, gmail, overleaf) run as an async function body → its JSON answer.
    func evaluate(_ script: String) async throws -> JSONValue
    func download(_ url: String, dir: String, name: String, maxBytes: Int?, quiet: Bool) async throws -> (path: String, bytes: Int, type: String, url: String)
    func url() -> String
}

/// The import's session as its tools see it (tools.cjs `session`).
public final class ToolSession: @unchecked Sendable {
    public var dataRoot: String
    public var homeDir: String
    public var dir: String
    public var downloads: String
    public var readable: ((String) -> Bool)?
    public var apps: [String]
    public var group: String?
    public var browseSites: [String]?
    public var approvedFor: ((String) -> Set<String>?)?
    public var exports: () -> [String: String]
    public var folders: () -> [String: String]
    public var days: () -> Double?
    public var gmailThreads: () -> Int
    public var setGmailThreads: (Int) -> Void
    public init(dataRoot: String, homeDir: String, dir: String, downloads: String, readable: ((String) -> Bool)? = nil, apps: [String] = [], group: String? = nil,
                browseSites: [String]? = nil, approvedFor: ((String) -> Set<String>?)? = nil, exports: @escaping () -> [String: String] = { [:] },
                folders: @escaping () -> [String: String] = { [:] }, days: @escaping () -> Double? = { nil }, gmailThreads: @escaping () -> Int = { 0 }, setGmailThreads: @escaping (Int) -> Void = { _ in }) {
        self.dataRoot = dataRoot; self.homeDir = homeDir; self.dir = dir; self.downloads = downloads; self.readable = readable; self.apps = apps; self.group = group
        self.browseSites = browseSites; self.approvedFor = approvedFor; self.exports = exports; self.folders = folders; self.days = days
        self.gmailThreads = gmailThreads; self.setGmailThreads = setGmailThreads
    }
}

/// What an agent's needs_you hands to the session (session.cjs askPerson / waitAgain).
public struct ToolNeeds: Sendable {
    public var ask: @Sendable (_ kind: String, _ reason: String) async -> JSONValue
    public var wait: @Sendable () async -> JSONValue
    public init(ask: @escaping @Sendable (String, String) async -> JSONValue, wait: @escaping @Sendable () async -> JSONValue) { self.ask = ask; self.wait = wait }
}

public enum Tools {
    public static let chatApps = ["Claude Code", "Codex", "Cursor", "Claude", "ChatGPT"]
    static let maxFilesACall = 300, maxChatsACall = 100, maxZoteroACall = 300, maxPdfsACall = 200, maxPdfChecks = 80, maxGoogleACall = 25, maxWebChatsACall = 40
    static let zoteroSyncWaitMs = 180_000.0
    static let callBudgetMs = 170_000.0
    public static let maxNoteChars = 200_000
    static let gmailMaxBytes = 5 * 1024 * 1024
    static let googleIdRE = #"^[\w-]{10,120}$"#
    static let overleafIdRE = "^[0-9a-f]{24}$"
    public static let needsKinds = ["signin", "2fa", "password", "captcha", "permission", "connector", "confirm"]
    static let googleKinds = ["doc", "sheet", "slides", "file", "pdf"]

    /// IMPORT_TOOLS (names, descriptions and schemas exactly as the Electron source writes them).
    public static let definitions: [JSONValue] = (try? JSONValue.parse(Texts.importToolsJSON))?.array ?? []
    public static let toolsForKind: [String: [String]] = ((try? JSONValue.parse(Texts.toolsForJSON))?.object ?? [:]).mapValues { $0.array?.compactMap(\.string) ?? [] }
    public static let writing: Set<String> = ["import_note_files", "import_pdfs", "add_note", "add_to_library", "unpack", "import_chats", "import_web_chats", "browser_download",
                                              "import_google_files", "import_gmail_threads", "import_overleaf_projects", "import_apple_notes", "import_zotero_items"]
    public static let browsing = ["browser_open", "browser_read", "browser_click", "browser_type", "browser_press", "browser_scroll", "browser_wait", "browser_screenshot", "browser_download"]
    public static let fixedReaderApps: Set<String> = ["ChatGPT", "Claude", "Overleaf", "Gmail"]
    public static let approvalApps: Set<String> = ["Google Docs", "Google Meet", "Overleaf"]
    static let browseSites: [String: [String]] = ["Google Docs": ["drive.google.com", "docs.google.com"], "Google Meet": ["drive.google.com", "docs.google.com"], "Gemini": ["gemini.google.com"]]
    static let surveySites: [String: [String]] = ["Google Docs": ["drive.google.com"], "Google Meet": ["drive.google.com"]]

    static func kindTools(_ kind: String) -> [String] { toolsForKind[kind] ?? toolsForKind["import"] ?? [] }

    /// The web apps of `apps` an agent may browse: on the web, not read by a fixed reader, not approved one by one.
    public static func browsedApps(_ apps: [String], approvals: Bool = false) -> [String] {
        apps.filter { ConnectSources.apps[$0]?.reach == .web && !fixedReaderApps.contains($0) && !(approvals && approvalApps.contains($0)) }
    }
    static func recalledApps(_ kind: String, _ apps: [String]) -> [String] { kind == "recall" ? apps.filter { ConnectSources.apps[$0]?.memory == true } : [] }

    /// The sites an agent of `kind` may browse for `apps` (and `extraSites`), the sign-in pages aside.
    public static func browseSitesFor(_ kind: String, apps: [String], extraSites: [String] = [], approvals: Bool = false) -> [String] {
        let sites = browsedApps(apps, approvals: approvals && kind != "survey").flatMap { (kind == "survey" ? surveySites[$0] : nil) ?? browseSites[$0] ?? ConnectSources.apps[$0]?.sites ?? [] }
        var out: [String] = []
        for s in sites + recalledApps(kind, apps).flatMap({ browseSites[$0] ?? ConnectSources.apps[$0]?.sites ?? [] }) + extraSites where !out.contains(s) { out.append(s) }
        return out
    }

    /// The tools one job's agent gets: its kind's, without the browser's when it has none or browses nothing.
    public static func toolNamesFor(_ kind: String, apps: [String] = [], extraSites: [String] = [], page: Bool = true, approvals: Bool = false) -> [String] {
        let browses = page && (!browsedApps(apps, approvals: approvals && kind != "survey").isEmpty || !recalledApps(kind, apps).isEmpty || !extraSites.isEmpty)
        return kindTools(kind).filter { browses || !browsing.contains($0) }
    }

    /// The tool definitions an agent of `kind` is served; `only` the names its job gets, when given.
    public static func toolsFor(_ kind: String, only: [String]? = nil) -> [JSONValue] {
        let names = Set(kindTools(kind))
        return definitions.filter { def in let n = JS.string(def["name"]); return names.contains(n) && (only.map { $0.contains(n) } ?? true) }
    }

    /// Arguments as a tool's schema says, or an error (tools.cjs validateImportTool).
    public static func validate(_ name: String, _ args: JSONValue) throws {
        guard let tool = definitions.first(where: { JS.string($0["name"]) == name }), case .object(let given) = args else { throw ConnectError("failed", "Unknown tool") }
        let properties = tool["inputSchema"]?["properties"]?.object ?? [:]
        for key in tool["inputSchema"]?["required"]?.array?.compactMap(\.string) ?? [] where given[key] == nil { throw ConnectError("failed", "\(key) is required") }
        for (key, value) in given {
            guard let type = properties[key] else { throw ConnectError("failed", "Unknown argument \(key)") }
            let t = type["type"]?.string ?? ""
            if t == "array" && type["items"]?["type"]?.string == "object" {
                guard let list = value.array, list.allSatisfy({ item in
                    guard case .object(let o) = item else { return false }
                    return o.values.allSatisfy { if let s = $0.string { return !s.contains("\0") && s.utf16.count <= 4096 }; return false }
                }) else { throw ConnectError("failed", "\(key) must be a list of objects of text") }
            } else if t == "array" {
                guard let list = value.array, list.allSatisfy({ if let s = $0.string { return !s.contains("\0") && s.utf16.count <= 4096 }; return false }) else { throw ConnectError("failed", "\(key) must be a list of text") }
            } else if t == "number" {
                guard let n = value.double, n.isFinite else { throw ConnectError("failed", "\(key) must be a number") }
            } else if t == "string" {
                guard value.string != nil else { throw ConnectError("failed", "\(key) must be a string") }
            } else if t == "boolean" {
                guard value.bool != nil else { throw ConnectError("failed", "\(key) must be a boolean") }
            }
            if let s = value.string, s.contains("\0") || (!["markdown", "script", "text"].contains(key) && s.utf16.count > 4096) { throw ConnectError("failed", "\(key) is not valid") }
        }
    }

    /// A chat as the note that keeps it.
    public static func chatNote(_ app: String, title: String, date: String?, project: String, turns: [Readers.Turn]) -> String {
        let who = ["ChatGPT", "Codex", "Cursor"].contains(app) ? app : "Claude"
        let head = [app, String((date ?? "").prefix(10)), project].filter { !$0.isEmpty }.joined(separator: " · ")
        let body = turns.map { "**\($0.role == "user" ? "You" : who):** \($0.text.trimmingCharacters(in: .whitespacesAndNewlines))" }.joined(separator: "\n\n")
        return Names.clipMiddle("*\(head)*\n\n\(body)\n", maxNoteChars)
    }

    /// Google's Markdown export keeps a document's pictures as data: links at its end (![][image1]): each written into
    /// `dir` and linked by its path.
    public static func googleMarkdown(_ text: String, dir: String) -> String {
        var files: [String: String] = [:]
        var n = 0
        var body = AppleNotes.sub(text, #"^\[([^\]\n]+)\]:\s*<?data:image/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)>?\s*$"#, options: [.caseInsensitive, .anchorsMatchLines]) { g in
            n += 1
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let kind = g[2].lowercased()
            let file = (dir as NSString).appendingPathComponent("picture-\(String(Int(Time.ms()), radix: 36))-\(n).\(kind == "jpeg" ? "jpg" : kind)")
            if let data = Data(base64Encoded: JS.replace(g[3], #"\s+"#, "")) { FileManager.default.createFile(atPath: file, contents: data, attributes: [.posixPermissions: 0o600]) }
            files[g[1].lowercased()] = file
            return ""
        }
        body = AppleNotes.sub(body, #"!\[([^\]\n]*)\]\[([^\]\n]+)\]"#, options: []) { g in files[g[2].lowercased()].map { "![\(g[1].isEmpty ? g[2] : g[1])](\($0))" } ?? g[0] }
        return JS.replace(body, #"\n{3,}"#, "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A CSV (a sheet's export) as a Markdown table: the first 200 rows and 20 columns.
    public static func csvTable(_ text: String) -> String {
        var rows: [[String]] = []
        var row: [String] = [], cell = "", quoted = false
        let chars = Array(text)
        var i = 0
        while i < chars.count && rows.count < 201 {
            let ch = chars[i]
            if quoted {
                if ch == "\"" && i + 1 < chars.count && chars[i + 1] == "\"" { cell.append("\""); i += 1 } else if ch == "\"" { quoted = false } else { cell.append(ch) }
                i += 1; continue
            }
            if ch == "\"" { quoted = true }
            else if ch == "," { row.append(cell); cell = "" }
            else if ch == "\n" || ch == "\r" || ch == "\r\n" { row.append(cell); rows.append(row); row = []; cell = "" }
            else { cell.append(ch) }
            i += 1
        }
        if !cell.isEmpty || !row.isEmpty { row.append(cell); rows.append(row) }
        let kept = rows.filter { $0.contains { !$0.trimmingCharacters(in: .whitespaces).isEmpty } }.prefix(200).map { r in
            r.prefix(20).map { JS.replace($0.replacingOccurrences(of: "|", with: "\\|"), #"\s+"#, " ").trimmingCharacters(in: .whitespaces) }
        }
        guard !kept.isEmpty else { return "" }
        let width = kept.map(\.count).max() ?? 0
        let line: ([String]) -> String = { r in "| \((0..<width).map { $0 < r.count ? r[$0] : "" }.joined(separator: " | ")) |" }
        return ([line(kept[0]), "|\(String(repeating: " --- |", count: width))"] + kept.dropFirst().map(line)).joined(separator: "\n")
    }

    /// The .tex file of an unpacked Overleaf project that has \documentclass, main.tex first.
    public static func findMainTex(_ folder: String) -> String? {
        var all: [String] = []
        Readers.walkFiles(folder, max: 5000) { file, name in if JS.test(name, #"\.tex$"#, options: .caseInsensitive) { all.append(file) } }
        let ordered = all.filter { ($0 as NSString).lastPathComponent.lowercased() == "main.tex" } + all.filter { ($0 as NSString).lastPathComponent.lowercased() != "main.tex" }
        return ordered.first { file in
            guard let text = try? String(contentsOfFile: file, encoding: .utf8) else { return false }
            return String(text.prefix(20000)).contains("\\documentclass")
        }
    }

    static let overleafScript = """

        const meta = document.querySelector('meta[name="ol-prefetchedProjectsBlob"]');
        if (meta) { try { const blob = JSON.parse(meta.content); return { projects: (blob.projects || []).map((p) => ({ id: p.id, name: p.name, updated: p.lastUpdated, owner: p.owner && (p.owner.email || ((p.owner.firstName || '') + ' ' + (p.owner.lastName || '')).trim()), archived: !!p.archived, trashed: !!p.trashed })) }; } catch (e) {} }
        if (/\\/login/.test(location.pathname) || document.querySelector('form[action*="login"]')) return { signedIn: false };
        return { projects: [...document.querySelectorAll('a[href^="/project/"]')].map((a) => ({ id: a.getAttribute('href').split('/')[2], name: a.textContent.trim() })) };
"""
}

/// What has been brought in from where, kept across sessions of one data root (`.connect/imported.json`).
public final class Imported: @unchecked Sendable {
    let file: URL
    var held: Set<String>?
    let lock = NSLock()
    public init(dataRoot: String) { file = URL(fileURLWithPath: dataRoot).appendingPathComponent(".connect/imported.json") }
    func load() -> Set<String> {
        if let held { return held }
        let set = Set((Files.readJSON(file)?.array ?? []).compactMap(\.string))
        held = set
        return set
    }
    public func has(_ key: String) -> Bool { lock.lock(); defer { lock.unlock() }; return load().contains(key) }
    public func add(_ key: String) {
        lock.lock(); defer { lock.unlock() }
        var set = load()
        set.insert(key)
        held = set
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? Files.writeAtomically(JSONValue.array(set.sorted().map { .string($0) }).text(), to: file, mode: 0o600)
    }
}

/// tools.cjs createImportTools: the tools of one import → call(name, args).
public final class ImportTools: @unchecked Sendable {
    let session: ToolSession
    let store: ConnectStore
    let kind: String
    let page: AgentPage?
    let needs: ToolNeeds?
    let recall: ((String, String) async -> Void)?
    let asked: (String, String) -> Void
    let question: String
    let appleNotes: AppleNotes?
    let zotero: ConnectZotero
    let github: ConnectGitHub
    let env: [String: String]
    let added: (String, Int, String?) -> Void
    let kept: (LibraryRow) -> Void
    let log: (String) -> Void
    let allowed: Set<String>
    let imported: Imported
    let index = Notes.Index()
    let browseHosts: [String]?
    var waiting = false
    var sent = false
    var chat: (app: String, id: String, done: Bool)?
    var zoteroWait: Task<JSONValue?, Never>?
    let stateLock = NSLock()

    public init(session: ToolSession, store: ConnectStore, kind: String = "import", page: AgentPage? = nil, needs: ToolNeeds? = nil,
                recall: ((String, String) async -> Void)? = nil, asked: @escaping (String, String) -> Void = { _, _ in }, question: String = "",
                appleNotes: AppleNotes? = nil, zotero: ConnectZotero = .none, github: ConnectGitHub = .none, env: [String: String] = ProcessInfo.processInfo.environment,
                only: [String]? = nil, added: @escaping (String, Int, String?) -> Void = { _, _, _ in }, kept: @escaping (LibraryRow) -> Void = { _ in },
                log: @escaping (String) -> Void = { _ in }) {
        self.session = session; self.store = store; self.kind = kind; self.page = page; self.needs = needs; self.recall = recall; self.asked = asked
        self.question = question; self.appleNotes = appleNotes; self.zotero = zotero; self.github = github; self.env = env; self.added = added; self.kept = kept; self.log = log
        allowed = Set(Tools.kindTools(kind).filter { only == nil || only!.contains($0) })
        imported = Imported(dataRoot: session.dataRoot)
        browseHosts = session.browseSites.map { AgentBrowser.hostsFor($0) }
    }

    var homeDir: String { session.homeDir }
    func downloads(_ part: String) -> String { ((session.downloads.isEmpty ? (session.dir as NSString).appendingPathComponent("downloads") : session.downloads) as NSString).appendingPathComponent(part) }

    /// The period (2026-10-10): the session's caps a longer ask; a shorter one is kept.
    func within(_ days: Double?, _ fallback: Double? = nil) -> Double? {
        let period = session.days().flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        let asked = days.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? fallback
        guard let period else { return days ?? fallback }
        if let asked, asked < period { return asked }
        return period
    }

    func ctxNow() async throws {
        if await store.dataRoot() != session.dataRoot { throw ConnectError("failed", "Engelbart switched to another library while this import ran; it stopped.") }
    }

    func where_(_ value: String?, _ what: String = "path") throws -> String {
        guard let file = Readers.expandPath(homeDir, value) else { throw ConnectError("failed", "\(what) must be absolute or start with ~/") }
        if file != homeDir && !file.hasPrefix(homeDir + "/") { throw ConnectError("failed", "Only files inside the home directory can be read") }
        if let readable = session.readable, !readable(file) { throw ConnectError("failed", "macOS has not let Engelbart read \(Readers.shownPath(homeDir, file)): leave it out, and say so in your reply.") }
        return file
    }

    func exportOf(_ app: String) throws -> String {
        guard let file = session.exports()[app] else { throw ConnectError("failed", "There is no \(app) export on this Mac; use web_chats for \(app).") }
        return file
    }

    func browser() throws -> AgentPage {
        guard let page else { throw ConnectError("failed", "Engelbart's browser is not available to this agent. Say so in your reply.") }
        return page
    }

    /// The browser for an agent's own step: refused on (or to) a page outside the sites this job browses.
    func browsing(_ url: String? = nil) throws -> AgentPage {
        let p = try browser()
        let at = url ?? p.url()
        if let hosts = browseHosts, !at.isEmpty, at != "about:blank", !AgentBrowser.hostAllowed(at, hosts) {
            let host = URL(string: at)?.host ?? ""
            let fixed = !host.isEmpty && ConnectSources.appOrder.contains { Tools.fixedReaderApps.contains($0) && AgentBrowser.hostAllowed(at, ConnectSources.apps[$0]?.sites ?? []) }
            throw ConnectError("failed", "\(host.isEmpty ? "That page" : host) is not one this agent may browse\(url != nil ? "" : " (open one of its sites first)"): \(fixed ? "that app is read only with its own tools" : "only its own sites").")
        }
        return p
    }

    /// The ids the person approved for `apps` (the librarian's run), or nil where anything may be read.
    func approvedFor(_ apps: [String]) -> Set<String>? {
        guard let f = session.approvedFor else { return nil }
        let sets = apps.compactMap { f($0) }
        return sets.isEmpty ? nil : sets.reduce(Set<String>()) { $0.union($1) }
    }
    static let notApproved = "the person did not approve it: only what they ticked comes in"

    // What a row knows about itself (Library Phase B, 2026-10-11).
    func appFor(_ file: String? = nil) -> String? {
        if let file { for (app, dir) in session.folders() where !dir.isEmpty && (file == dir || file.hasPrefix(dir + "/")) { return app } }
        return session.apps.count == 1 ? session.apps[0] : nil
    }
    func knows(_ app: String?, _ more: [String: JSONValue] = [:]) -> JSONValue {
        var out: [String: JSONValue] = [:]
        let source = app == "GitHub" ? "github" : (app.flatMap { ConnectSources.itemSources.contains($0) ? $0 : nil })
        let category = app.flatMap { ConnectSources.categoryOfApp($0) } ?? (app == nil ? session.group.flatMap { ConnectSources.groupCategories[$0] } : nil)
        if let source { out["source"] = .string(source) }
        if let category { out["category"] = .string(category) }
        for (k, v) in more where !v.isNull && v != .string("") { out[k] = v }
        return .object(out)
    }
    func dayOf(_ value: String?) -> JSONValue {
        let day = String((value ?? "").prefix(10))
        return JS.test(day, #"^\d{4}-\d{2}-\d{2}$"#) && Time.parse(day + "T00:00:00Z") != nil ? .string(day) : .null
    }
    func placeOf(_ file: String, _ root: String) -> JSONValue {
        guard !root.isEmpty, file.hasPrefix(root + "/") else { return .null }
        let rel = Readers.relative(root, (file as NSString).deletingLastPathComponent)
        return .string(([(root as NSString).lastPathComponent] + (rel.isEmpty ? [] : rel.components(separatedBy: "/"))).joined(separator: "/"))
    }

    func putNote(title: String, body: String, images: [ConvertedNote.Image] = [], source: String?, about: JSONValue?) async throws {
        try await ctxNow()
        let row = try await Notes.writeFile(title: title, body: body, images: images, about: about, library: store)
        kept(row)
        if let source, !source.isEmpty { imported.add(source) }
        added("notes", 1, title)
    }

    func addRow(_ input: String, _ name: String?, describe: Bool = true, about: JSONValue? = nil) async throws -> JSONValue {
        try await ctxNow()
        do {
            let row = try await store.addItem(input, name: name, describe: describe, about: about)
            kept(row)
            added("items", 1, row.name)
            return ["added": true, "id": .string(row.id), "name": .string(row.name), "type": .string(row.type), "tags": .array(row.tags.map { .string($0) })]
        } catch let e as LibraryExists {
            if let row = e.row { kept(row) }
            return ["added": false, "already": e.row.map { .string($0.name) } ?? true]
        }
    }

    func addFile(_ file: String, _ name: String, url: String? = nil, about: JSONValue? = nil) async throws -> JSONValue {
        let ext = Notes.ext(file).lowercased()
        let mimes = [".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"]
        guard let mime = mimes[ext] else { return try await addRow(file, name, describe: false, about: about) }
        try await ctxNow()
        guard let bytes = FileManager.default.contents(atPath: file) else { throw ConnectError("failed", "not there") }
        do {
            let row = try await store.addFileCopy(bytes: bytes, mime: mime, name: name, url: url, about: about)
            kept(row)
            added("items", 1, row.name)
            return ["added": true, "id": .string(row.id), "name": .string(row.name), "type": .string(row.type)]
        } catch let e as LibraryExists {
            if let row = e.row { kept(row) }
            return ["added": false, "already": e.row.map { .string($0.name) } ?? true]
        }
    }

    /// A zip's files written into a folder of the imports (names that would leave it are passed over).
    func unzipInto(_ zip: String, _ folder: String) throws -> (folder: String, files: Int, skipped: Int) {
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let list = Process()
        list.executableURL = URL(fileURLWithPath: "/usr/bin/zipinfo")
        list.arguments = ["-1", zip]
        let out = Pipe(); list.standardOutput = out; list.standardError = FileHandle.nullDevice
        try list.run()
        let names = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).components(separatedBy: "\n").filter { !$0.isEmpty }
        list.waitUntilExit()
        let safe = names.filter { !Names.safeArchiveName($0).isEmpty && !$0.hasSuffix("/") }
        let skipped = names.filter { !$0.hasSuffix("/") }.count - safe.count
        if !safe.isEmpty {
            let unzip = Process()
            unzip.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
            unzip.arguments = ["-o", "-qq", zip] + safe + ["-d", folder]
            unzip.standardOutput = FileHandle.nullDevice; unzip.standardError = FileHandle.nullDevice
            try unzip.run()
            unzip.waitUntilExit()
        }
        return (folder, safe.count, skipped)
    }

    func chatApp(_ app: String) throws -> String {
        guard Tools.chatApps.contains(app) else { throw ConnectError("failed", "app must be one of \(Tools.chatApps.joined(separator: ", "))") }
        return app
    }
    func listLocal(_ app: String, days: Double?, project: String, query: String, limit: Int, automated: Bool) throws -> [JSONValue] {
        if app == "Cursor" { return try Cursor.chats(homeDir: homeDir, days: days, query: query, limit: limit).map { ["id": .string($0.id), "title": .string($0.title), "first": .string($0.first), "project": "", "date": $0.date.map { .string($0) } ?? .null, "turns": .number(Double($0.turns))] } }
        if app == "Claude" || app == "ChatGPT" { return try Readers.exportChats(try exportOf(app), days: days, query: query, limit: limit) }
        return Readers.localChats(app, homeDir: homeDir, env: env, days: days, project: project, query: query, limit: limit, automated: automated).map(\.json)
    }
    func readLocal(_ app: String, _ id: String) throws -> Readers.Transcript {
        if app == "Cursor" { let t = try Cursor.transcript(homeDir: homeDir, id: id); return Readers.Transcript(title: t.title, project: t.project, date: t.date, turns: t.turns.map { Readers.Turn(role: $0.role, text: $0.text) }) }
        if app == "Claude" || app == "ChatGPT" { return try Readers.exportTranscript(try exportOf(app), id) }
        return try Readers.localTranscript(app, id, homeDir: homeDir, env: env)
    }

    static func n(_ v: JSONValue?) -> Double? { v?.double }
    static func s(_ v: JSONValue?, _ d: String = "") -> String { v?.string ?? d }
    static func strs(_ v: JSONValue?) -> [String] { v?.array?.compactMap(\.string) ?? [] }
    static func signedOutGoogle() -> ConnectError { ConnectError("signed-out", "Not signed in to Google in Engelbart's browser. Call needs_you with kind \"signin\", then try again.") }
    static func skippedList(_ list: [JSONValue]) -> JSONValue { .array(Array(list.prefix(30))) }

    func looksSignedOut(_ file: String, _ type: String) -> Bool {
        if !JS.test(type, "html", options: .caseInsensitive) { return false }
        guard let head = (try? String(contentsOfFile: file, encoding: .utf8)).map({ String($0.prefix(4000)) }) else { return true }
        return JS.test(head, #"accounts\.google\.com|ServiceLogin|Sign in|<form"#, options: .caseInsensitive)
    }

    /// The tool `name` with `args` (validated, held to this agent's kind) → its JSON answer, or MCPContent.
    public func call(_ name: String, _ args: JSONValue) async throws -> Any {
        try Tools.validate(name, args)
        guard allowed.contains(name) else {
            throw ConnectError("failed", kind == "survey" && Tools.writing.contains(name) ? "A survey brings nothing in: report what you found instead." : "\(name) is not one of this agent's tools")
        }
        if kind != "recall" || !name.hasPrefix("browser_") { return try await run(name, args) }
        defer {
            if ["browser_type", "browser_press", "browser_click"].contains(name) && (name != "browser_type" || args["submit"] == .bool(true)) && (name != "browser_press" || args["key"]?.string == "Enter") { sent = true }
            noteChat()
        }
        return try await run(name, args)
    }

    func run(_ name: String, _ a: JSONValue) async throws -> Any {
        typealias T = ImportTools
        switch name {
        case "folder_overview":
            return Readers.folderOverview(try where_(T.s(a["path"])), homeDir: homeDir, readable: session.readable)
        case "list_note_files":
            let files = Readers.noteFiles(try where_(T.s(a["folder"]), "folder"), include: T.strs(a["include"]), exclude: T.strs(a["exclude"]), days: within(T.n(a["days"])), max: 5000, readable: session.readable)
            return JSONValue.object(["total": .number(Double(files.count)), "files": .array(files.prefix(2000).map { .string($0) }), "more": .number(Double(max(0, files.count - 2000)))])
        case "import_note_files":
            let files = T.strs(a["files"])
            if files.count > Tools.maxFilesACall { throw ConnectError("failed", "At most \(Tools.maxFilesACall) files a call") }
            let base = a["root"]?.string.flatMap { $0.isEmpty ? nil : $0 }.map { try? where_($0, "root") } ?? nil
            if let r = a["root"]?.string, !r.isEmpty, base == nil { _ = try where_(r, "root") }
            var count = 0
            var skipped: [JSONValue] = []
            for given in files {
                let file: String
                do { file = try where_(given) } catch { skipped.append(["file": .string(given), "why": .string((error as? ConnectError)?.message ?? "")]); continue }
                let key = "file:\(file)"
                if imported.has(key) { skipped.append(["file": .string(given), "why": "brought in before"]); continue }
                if !Readers.noteExt.contains(Readers.ext(file)) { skipped.append(["file": .string(given), "why": "not a note file"]); continue }
                guard let st = Readers.statOf(file) else { skipped.append(["file": .string(given), "why": "not there"]); continue }
                if !st.isFile || st.size > Notes.maxNoteBytes { skipped.append(["file": .string(given), "why": .string(st.isFile ? "larger than 5 MB" : "not a file")]); continue }
                let text = (try? String(contentsOfFile: file, encoding: .utf8)) ?? String(decoding: FileManager.default.contents(atPath: file) ?? Data(), as: UTF8.self)
                let converted = Notes.convertMarkdown(text, sourcePath: file, root: base ?? (file as NSString).deletingLastPathComponent, index: index)
                let from = appFor(file)
                let placeRoot = base ?? from.flatMap { session.folders()[$0] } ?? ""
                try await putNote(title: ((file as NSString).lastPathComponent as NSString).deletingPathExtension, body: converted.body, images: converted.images, source: key, about: knows(from, ["place": placeOf(file, placeRoot)]))
                count += 1
            }
            if count > 0 { log("Brought in \(count) note\(count == 1 ? "" : "s")") }
            return JSONValue.object(["added": .number(Double(count)), "skipped": T.skippedList(skipped), "skippedCount": .number(Double(skipped.count)), "where": "the library, as Markdown files in Engelbart's assets/md"])
        case "add_note":
            let markdown = T.s(a["markdown"])
            if markdown.utf16.count > Tools.maxNoteChars { throw ConnectError("failed", "A note is at most \(Tools.maxNoteChars) characters") }
            let key = a["source"]?.string.flatMap { $0.isEmpty ? nil : "note:\($0)" } ?? ""
            if !key.isEmpty && imported.has(key) { return JSONValue.object(["added": false, "why": "brought in before"]) }
            let converted = Notes.convertMarkdown(markdown, root: session.downloads)
            let title = T.s(a["title"])
            try await putNote(title: Names.sanitize(title), body: converted.body, images: converted.images, source: key, about: knows(appFor()))
            log("Wrote “\(String(title.prefix(60)))”")
            return JSONValue.object(["added": true])
        case "add_to_library":
            return try await addRow(T.s(a["input"]), a["name"]?.string, about: knows(appFor()))
        case "list_pdfs":
            let limit = min(1000, max(1, Int((T.n(a["limit"]) ?? 300).rounded())))
            var out = Readers.pdfFiles(try where_(T.s(a["folder"]), "folder"), days: within(T.n(a["days"])), query: T.s(a["query"]), kind: T.s(a["kind"]),
                                       include: T.strs(a["include"]), exclude: T.strs(a["exclude"]), limit: limit, readable: session.readable)
            var result: [String: JSONValue] = ["total": .number(Double(out.total))]
            if a["check"] == .bool(true) {
                let started = Time.ms()
                var checked = 0
                for i in out.pdfs.indices {
                    if checked >= Tools.maxPdfChecks || Time.ms() - started > Tools.callBudgetMs / 2 { break }
                    var o = out.pdfs[i].object ?? [:]
                    if let tags = try? await store.inspectPdf(JS.string(o["path"])) { o["paper"] = .bool(tags.contains("paper")) } else { o["paper"] = .null }
                    out.pdfs[i] = .object(o)
                    checked += 1
                }
                result["checked"] = .number(Double(checked))
            }
            result["pdfs"] = .array(out.pdfs)
            return JSONValue.object(result)
        case "import_pdfs":
            let files = T.strs(a["files"])
            if files.count > Tools.maxPdfsACall { throw ConnectError("failed", "At most \(Tools.maxPdfsACall) files a call") }
            let started = Time.ms()
            var count = 0
            var skipped: [JSONValue] = [], left: [JSONValue] = []
            for given in files {
                if Time.ms() - started > Tools.callBudgetMs { left.append(.string(given)); continue }
                let file: String
                do { file = try where_(given) } catch { skipped.append(["file": .string(given), "why": .string((error as? ConnectError)?.message ?? "")]); continue }
                let st = Readers.statOf(file)
                if st == nil || !st!.isFile || !JS.test(file, #"\.pdf$"#, options: .caseInsensitive) { skipped.append(["file": .string(given), "why": .string(st != nil ? "not a pdf" : "not there")]); continue }
                let out = try await addRow(file, nil, describe: false, about: knows(ConnectSources.localPDFs))
                if out["added"] == .bool(true) { count += 1 } else { skipped.append(["file": .string(given), "why": "in the library already"]) }
            }
            if count > 0 { log("Brought in \(count) PDF\(count == 1 ? "" : "s")") }
            return JSONValue.object(["added": .number(Double(count)), "skipped": T.skippedList(skipped), "skippedCount": .number(Double(skipped.count)), "left": .array(left)])
        case "unpack":
            let zip = try where_(T.s(a["file"]), "file")
            if !JS.test(zip, #"\.zip$"#, options: .caseInsensitive) { throw ConnectError("failed", "Only a .zip can be unpacked") }
            var stem = String(JS.replace(((zip as NSString).lastPathComponent as NSString).deletingPathExtension, #"[^\w .-]+"#, "-").prefix(80))
            if stem.isEmpty { stem = "unpacked" }
            let out = try unzipInto(zip, downloads(stem))
            log("Unpacked \((zip as NSString).lastPathComponent)")
            return JSONValue.object(["folder": .string(out.folder), "files": .number(Double(out.files)), "skipped": .number(Double(out.skipped)), "overview": Readers.folderOverview(out.folder, homeDir: homeDir, top: 15)])
        case "list_chats":
            let app = try chatApp(T.s(a["app"]))
            let cap = min(max(1, Int((T.n(a["limit"]) ?? 200).rounded())), 1000)
            return JSONValue.array(try listLocal(app, days: within(T.n(a["days"])), project: T.s(a["project"]), query: T.s(a["query"]), limit: cap, automated: a["automated"] == .bool(true)).map { chat in
                var o = chat.object ?? [:]
                o["imported"] = .bool(imported.has("chat:\(app):\(JS.string(chat["id"]))"))
                return .object(o)
            })
        case "read_chat":
            let app = try chatApp(T.s(a["app"]))
            let chat = try readLocal(app, T.s(a["id"]))
            let max = min(max(500, Int(T.n(a["max_chars"]) ?? 6000)), 40000)
            return JSONValue.object(["title": .string(chat.title), "date": chat.date.map { .string($0) } ?? .null, "project": .string(chat.project),
                                     "text": .string(Names.clipMiddle(chat.turns.map { "\($0.role): \($0.text)" }.joined(separator: "\n\n"), max))])
        case "import_chats":
            let app = try chatApp(T.s(a["app"]))
            let ids = T.strs(a["ids"])
            if ids.count > Tools.maxChatsACall { throw ConnectError("failed", "At most \(Tools.maxChatsACall) chats a call") }
            var count = 0
            var skipped: [JSONValue] = []
            for id in ids {
                let key = "chat:\(app):\(id)"
                if imported.has(key) { skipped.append(["id": .string(id), "why": "brought in before"]); continue }
                let chat: Readers.Transcript
                do { chat = try readLocal(app, id) } catch { skipped.append(["id": .string(id), "why": .string((error as? ConnectError)?.message ?? error.localizedDescription)]); continue }
                if chat.turns.isEmpty { skipped.append(["id": .string(id), "why": "no turns of text"]); continue }
                try await putNote(title: chat.title.isEmpty ? "\(app) chat" : chat.title, body: Tools.chatNote(app, title: chat.title, date: chat.date, project: chat.project, turns: chat.turns),
                                  source: key, about: knows(app, ["itemDate": dayOf(chat.date), "place": .string(chat.project), "messages": .number(Double(chat.turns.count))]))
                count += 1
            }
            if count > 0 { log("Brought in \(count) \(app) chat\(count == 1 ? "" : "s")") }
            return JSONValue.object(["added": .number(Double(count)), "skipped": T.skippedList(skipped), "skippedCount": .number(Double(skipped.count))])
        case "web_chats":
            let app = T.s(a["app"])
            let out = try await WebChats.list(try browser(), app, days: within(T.n(a["days"])), query: T.s(a["query"]), project: T.s(a["project"]), limit: T.n(a["limit"]) ?? 200)
            let chats = out["chats"]?.array ?? []
            log("Listed \(chats.count) \(app) chat\(chats.count == 1 ? "" : "s")")
            var o = out.object ?? [:]
            o["chats"] = .array(chats.map { c in var x = c.object ?? [:]; x["imported"] = .bool(imported.has("chat:\(app):\(JS.string(c["id"]))")); return .object(x) })
            return JSONValue.object(o)
        case "web_chat_read":
            let chat = try await WebChats.read(try browser(), T.s(a["app"]), T.s(a["id"]))
            let max = min(max(500, Int(T.n(a["max_chars"]) ?? 6000)), 40000)
            return JSONValue.object(["title": .string(chat.title), "date": chat.date.map { .string($0) } ?? .null, "text": .string(Names.clipMiddle(chat.turns.map { "\($0.role): \($0.text)" }.joined(separator: "\n\n"), max))])
        case "import_web_chats":
            let app = T.s(a["app"])
            let ids = T.strs(a["ids"])
            if ids.count > Tools.maxWebChatsACall { throw ConnectError("failed", "At most \(Tools.maxWebChatsACall) chats a call") }
            var count = 0
            var skipped: [JSONValue] = [], left: [JSONValue] = []
            let deadline = Time.ms() + Tools.callBudgetMs
            for id in ids {
                if Time.ms() > deadline { left.append(.string(id)); continue }
                let key = "chat:\(app):\(id)"
                if imported.has(key) { skipped.append(["id": .string(id), "why": "brought in before"]); continue }
                let chat: WebChats.Chat
                do { chat = try await WebChats.read(try browser(), app, id) } catch let e as ConnectError {
                    if e.kind == "signed-out" { throw e }
                    skipped.append(["id": .string(id), "why": .string(e.message)]); continue
                }
                if chat.turns.isEmpty { skipped.append(["id": .string(id), "why": "no turns of text"]); continue }
                try await putNote(title: chat.title, body: Tools.chatNote(app, title: chat.title, date: chat.date, project: chat.project ?? "", turns: chat.turns), source: key,
                                  about: knows(app, ["itemDate": dayOf(chat.date), "place": chat.project.map { .string($0) } ?? .null, "messages": .number(Double(chat.turns.count))]))
                count += 1
            }
            if count > 0 { log("Brought in \(count) \(app) chat\(count == 1 ? "" : "s")") }
            var o: [String: JSONValue] = ["added": .number(Double(count)), "skipped": T.skippedList(skipped), "skippedCount": .number(Double(skipped.count))]
            if !left.isEmpty { o["left"] = .array(left) }
            return JSONValue.object(o)
        case "browser_open": let url = T.s(a["url"]); return try await browsing(url).open(url)
        case "browser_read": return try await browsing().read(offset: Int(T.n(a["offset"]) ?? 0), maxChars: Int(T.n(a["max_chars"]) ?? 8000))
        case "browser_click": return try await browsing().click(T.s(a["ref"]))
        case "browser_type": return try await browsing().type(T.s(a["ref"]), T.s(a["text"]), submit: a["submit"] == .bool(true), replace: a["replace"] == .bool(true))
        case "browser_press": return try await browsing().press(T.s(a["key"]))
        case "browser_scroll": return try await browsing().scroll(ref: T.s(a["ref"]), direction: T.s(a["direction"], "down"), amount: T.n(a["amount"]) ?? 800)
        case "browser_wait": return try await browsing().wait(seconds: T.n(a["seconds"]) ?? 5, untilText: T.s(a["until_text"]), untilGone: T.s(a["until_gone"]), stable: a["stable"] == .bool(true))
        case "browser_screenshot":
            let shot = try await browsing().screenshot()
            return MCPContent([["type": "image", "data": .string(shot.data), "mimeType": .string(shot.mimeType)]])
        case "browser_download":
            let url = T.s(a["url"])
            let out = try await browsing(url).download(url, dir: downloads("files"), name: T.s(a["name"]), maxBytes: nil, quiet: false)
            return JSONValue.object(["path": .string(out.path), "bytes": .number(Double(out.bytes)), "type": .string(out.type)])
        case "import_google_files": return try await importGoogleFiles(a["items"]?.array ?? [])
        case "gmail_accounts": return try await gmailAccounts()
        case "gmail_search": return try await gmailSearch(a)
        case "import_gmail_threads": return try await importGmailThreads(a)
        case "overleaf_projects":
            let p = try browser()
            _ = try await p.ensure("https://www.overleaf.com/project")
            let out = try await p.evaluate(Tools.overleafScript)
            if out["signedIn"] == .bool(false) { throw ConnectError("signed-out", "Not signed in to Overleaf in Engelbart's browser. Call needs_you with kind \"signin\", then try again.") }
            let list = (out["projects"]?.array ?? []).filter { JS.test(JS.string($0["id"]), Tools.overleafIdRE) }
            log("Listed \(list.count) Overleaf project\(list.count == 1 ? "" : "s")")
            return JSONValue.object(["projects": .array(Array(list.prefix(500)))])
        case "import_overleaf_projects": return try await importOverleaf(T.strs(a["ids"]))
        case "apple_notes_folders":
            let out = try await appleNotesOf().folders()
            log("Read Apple Notes' folders")
            return out
        case "apple_notes_list":
            return JSONValue.array(try await appleNotesOf().list(folder: T.s(a["folder"]), days: within(T.n(a["days"])), query: T.s(a["query"]), limit: T.n(a["limit"]) ?? 500))
        case "import_apple_notes":
            let ids = T.strs(a["ids"])
            let wanted = ids.prefix(200).filter { !imported.has("apple-notes:\($0)") }
            let read = try await appleNotesOf().read(Array(wanted), pictureDir: downloads("apple-notes"))
            var count = 0
            var skipped: [JSONValue] = ids.count - wanted.count > 0 ? [["why": "brought in before", "count": .number(Double(ids.count - wanted.count))]] : []
            for note in read {
                if let error = note.error { skipped.append(["id": .string(note.id), "why": .string(String(error.prefix(120)))]); continue }
                let converted = Notes.convertMarkdown(note.markdown, root: downloads("apple-notes"))
                try await putNote(title: Names.sanitize(note.name), body: converted.body, images: converted.images, source: "apple-notes:\(note.id)",
                                  about: knows("Apple Notes", ["place": .string(note.folder), "itemDate": dayOf(note.modified)]))
                count += 1
            }
            if count > 0 { log("Brought in \(count) Apple Note\(count == 1 ? "" : "s")") }
            return JSONValue.object(["added": .number(Double(count)), "skipped": T.skippedList(skipped)])
        case "browser_history":
            guard let found = Readers.profileOf(homeDir, browser: T.s(a["browser"]), profile: T.s(a["profile"])) else { throw ConnectError("failed", "No Chromium browser profile with a history was found on this Mac") }
            log("Read \(found.browser)'s history")
            let entries = try Readers.browserHistory(found.dir, days: within(T.n(a["days"]), 90) ?? 90, limit: min(max(1, Int((T.n(a["limit"]) ?? 50).rounded())), 500),
                                                     by: T.s(a["by"]) == "page" ? "page" : "site", exclude: T.strs(a["exclude"]))
            return JSONValue.object(["browser": .string(found.browser), "profile": .string(found.name), "entries": .array(entries)])
        case "browser_bookmarks":
            guard let found = Readers.profileOf(homeDir, browser: T.s(a["browser"]), profile: T.s(a["profile"])) else { throw ConnectError("failed", "No Chromium browser profile was found on this Mac") }
            log("Read \(found.browser)'s bookmarks")
            return JSONValue.object(["browser": .string(found.browser), "profile": .string(found.name), "bookmarks": .array(Readers.browserBookmarks(found.dir))])
        case "links_in_notes":
            return JSONValue.array(Readers.linksIn(try where_(T.s(a["folder"]), "folder"), limit: min(max(1, Int((T.n(a["limit"]) ?? 200).rounded())), 1000)))
        case "zotero_collections":
            let c = try Readers.zoteroCollections(try await zoteroRoot())
            return JSONValue.object(["items": .number(Double(c.items)), "unfiled": .number(Double(c.unfiled)), "collections": .array(c.collections.map { ["key": .string($0.key), "path": .string($0.path), "items": .number(Double($0.items))] })])
        case "zotero_items":
            return JSONValue.array(try Readers.zoteroItems(try await zoteroRoot(), collection: T.s(a["collection"]), query: T.s(a["query"]), limit: min(max(1, Int((T.n(a["limit"]) ?? 500).rounded())), 2000)))
        case "import_zotero_items": return try await importZotero(T.strs(a["keys"]))
        case "github_repos":
            guard github.status()?.connected == true, let repos = github.repos else { throw ConnectError("failed", "GitHub is not signed in. Call needs_you with kind \"signin\" and reason \"Sign in to GitHub\".") }
            let out = try await repos([])
            return JSONValue.array((out["repos"]?.array ?? []).map { r in ["fullName": r["fullName"] ?? .null, "url": r["url"] ?? .null, "description": .string(JS.string(r["description"])), "private": .bool(JS.truthy(r["private"]))] })
        case "needs_you":
            guard let needs else { throw ConnectError("failed", "Nobody can be asked from here. Say what you could not do in your reply.") }
            let what = T.s(a["kind"])
            guard Tools.needsKinds.contains(what) else { throw ConnectError("failed", "kind must be one of \(Tools.needsKinds.joined(separator: ", "))") }
            stateLock.lock(); waiting = true; stateLock.unlock()
            let out = await needs.ask(what, String(JS.replace(T.s(a["reason"]), #"\s+"#, " ").trimmingCharacters(in: .whitespaces).prefix(160)))
            if out["status"]?.string != "waiting" { stateLock.lock(); waiting = false; stateLock.unlock() }
            return out
        case "wait_for_you":
            stateLock.lock(); let w = waiting; stateLock.unlock()
            guard let needs, w else { return JSONValue.object(["status": "done", "note": "Nothing is waiting on the person."]) }
            let out = await needs.wait()
            if out["status"]?.string != "waiting" { stateLock.lock(); waiting = false; stateLock.unlock() }
            return out
        case "save_memory":
            guard let recall else { throw ConnectError("failed", "This agent does not keep memories") }
            let app = T.s(a["app"])
            let value = T.s(a["text"]).trimmingCharacters(in: .whitespacesAndNewlines)
            if value.count < 20 { throw ConnectError("failed", "That answer is too short to keep: read the whole answer first") }
            await recall(app, value)
            let f = NumberFormatter(); f.numberStyle = .decimal; f.locale = Locale(identifier: "en_US")
            log("Kept what \(app) remembers (\(f.string(from: NSNumber(value: value.utf16.count)) ?? "") characters)")
            await forgetQuestion(app)
            return JSONValue.object(["saved": true, "chars": .number(Double(value.utf16.count))])
        default:
            throw ConnectError("failed", "Unknown tool")
        }
    }

    // MARK: Google Drive

    func importGoogleFiles(_ items: [JSONValue]) async throws -> JSONValue {
        if items.count > Tools.maxGoogleACall { throw ConnectError("failed", "At most \(Tools.maxGoogleACall) files a call") }
        let p = try browser()
        var count = 0
        var skipped: [JSONValue] = [], left: [JSONValue] = []
        let deadline = Time.ms() + Tools.callBudgetMs
        let approved = approvedFor(["Google Docs", "Google Meet"])
        for item in items {
            let id = JS.string(item["id"])
            if Time.ms() > deadline { left.append(.string(id)); continue }
            let kindOf = (item["kind"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "doc").lowercased()
            let named = JS.string(item["name"]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !JS.test(id, Tools.googleIdRE) { skipped.append(["id": .string(id), "why": "not a Drive id"]); continue }
            if let approved, !approved.contains(id) { skipped.append(["id": .string(id), "why": .string(ImportTools.notApproved)]); continue }
            if !Tools.googleKinds.contains(kindOf) { skipped.append(["id": .string(id), "why": .string("kind must be one of \(Tools.googleKinds.joined(separator: ", "))")]); continue }
            let key = "google:\(id)"
            if imported.has(key) { skipped.append(["id": .string(id), "why": "brought in before"]); continue }
            let origin: JSONValue = .string("https://drive.google.com/open?id=\(id)")
            do {
                if ["doc", "sheet", "slides"].contains(kindOf) {
                    let url = kindOf == "doc" ? "https://docs.google.com/document/d/\(id)/export?format=md" : kindOf == "sheet" ? "https://docs.google.com/spreadsheets/d/\(id)/export?format=csv" : "https://docs.google.com/presentation/d/\(id)/export/txt"
                    let got = try await p.download(url, dir: downloads("google"), name: "\(id).\(kindOf == "doc" ? "md" : kindOf == "sheet" ? "csv" : "txt")", maxBytes: nil, quiet: true)
                    if looksSignedOut(got.path, got.type) { try? FileManager.default.removeItem(atPath: got.path); throw ImportTools.signedOutGoogle() }
                    let text = (try? String(contentsOfFile: got.path, encoding: .utf8)) ?? ""
                    try? FileManager.default.removeItem(atPath: got.path)
                    let markdown = kindOf == "doc" ? Tools.googleMarkdown(text, dir: downloads("google")) : kindOf == "sheet" ? Tools.csvTable(text) : text.trimmingCharacters(in: .whitespacesAndNewlines)
                    let heading = JS.match(markdown, #"^#\s+(.+)$"#, options: .anchorsMatchLines)?[1] ?? nil
                    let title = !named.isEmpty ? named : heading ?? "Google \(kindOf) \(id.prefix(8))"
                    let converted = Notes.convertMarkdown(markdown, root: downloads("google"))
                    try await putNote(title: Names.sanitize(title), body: "*Google Drive · https://drive.google.com/open?id=\(id)*\n\n\(converted.body)", images: converted.images, source: key, about: knows("Google Docs", ["originUrl": origin]))
                } else {
                    var got = try await p.download("https://drive.google.com/uc?export=download&id=\(id)", dir: downloads("google"), name: named, maxBytes: nil, quiet: true)
                    if JS.test(got.type, "html", options: .caseInsensitive) { // a large file's virus-scan warning, or a sign-in page
                        try? FileManager.default.removeItem(atPath: got.path)
                        got = try await p.download("https://drive.usercontent.google.com/download?id=\(id)&export=download&confirm=t", dir: downloads("google"), name: named, maxBytes: nil, quiet: true)
                        if looksSignedOut(got.path, got.type) { try? FileManager.default.removeItem(atPath: got.path); throw ImportTools.signedOutGoogle() }
                    }
                    let ext = Notes.ext(got.path).lowercased()
                    if Readers.noteExt.contains(ext) {
                        let converted = Notes.convertMarkdown((try? String(contentsOfFile: got.path, encoding: .utf8)) ?? "", sourcePath: got.path, root: (got.path as NSString).deletingLastPathComponent)
                        try await putNote(title: Names.sanitize(named.isEmpty ? ((got.path as NSString).lastPathComponent as NSString).deletingPathExtension : named), body: converted.body, images: converted.images, source: key, about: knows("Google Docs", ["originUrl": origin]))
                    } else {
                        let out = try await addFile(got.path, named.isEmpty ? ((got.path as NSString).lastPathComponent as NSString).deletingPathExtension : named, about: knows("Google Docs", ["originUrl": origin]))
                        imported.add(key)
                        if out["added"] != .bool(true) { skipped.append(["id": .string(id), "why": "in the library already"]); continue }
                    }
                }
                count += 1
            } catch let e as ConnectError {
                if e.kind == "signed-out" { throw e }
                skipped.append(["id": .string(id), "why": .string(String(e.message.prefix(200)))])
            }
        }
        if count > 0 { log("Brought in \(count) Google Drive file\(count == 1 ? "" : "s")") }
        var o: [String: JSONValue] = ["added": .number(Double(count)), "skipped": ImportTools.skippedList(skipped), "skippedCount": .number(Double(skipped.count))]
        if !left.isEmpty { o["left"] = .array(left) }
        return .object(o)
    }

    // MARK: Gmail

    static func gmailSignedOut() -> ConnectError { ConnectError("signed-out", "Not signed in to Google in Engelbart's browser. Call needs_you with kind \"signin\", then try again.") }

    func gmailAccounts() async throws -> JSONValue {
        let p = try browser()
        var accounts: [JSONValue] = []
        var seen = Set<String>()
        let deadline = Time.ms() + Tools.callBudgetMs
        for n in 0..<Gmail.maxAccounts {
            if Time.ms() > deadline { return ["accounts": .array(accounts), "more": true] }
            let opened = try await p.open(Gmail.inboxUrl(n))
            let at = JS.string(opened["url"])
            if !at.hasPrefix("https://mail.google.com/") { if n == 0 { throw ImportTools.gmailSignedOut() }; break }
            if let placed = JS.match(at, #"/mail/u/(\d+)/"#)?[1] ?? nil, Int(placed) != n { break }
            let out = try await p.evaluate(Gmail.accountScript)
            if out["signedIn"] != .bool(true) { if n == 0 { throw ImportTools.gmailSignedOut() }; break }
            let address = String(JS.string(out["address"]).prefix(200)), ik = JS.test(JS.string(out["ik"]), Gmail.ikRE) ? JS.string(out["ik"]) : ""
            let key = address.isEmpty ? ik : address.lowercased()
            if key.isEmpty || seen.contains(address.lowercased()) || (!ik.isEmpty && seen.contains(ik)) { break }
            if !address.isEmpty { seen.insert(address.lowercased()) }
            if !ik.isEmpty { seen.insert(ik) }
            accounts.append(["n": .number(Double(n)), "address": .string(address)])
        }
        log("Found \(accounts.count) Gmail account\(accounts.count == 1 ? "" : "s")")
        return ["accounts": .array(accounts)]
    }

    func gmailSearch(_ a: JSONValue) async throws -> JSONValue {
        let n = try Gmail.accountIndex(a["n"])
        let words = JS.replace(JS.string(a["query"]), #"\s+"#, " ").trimmingCharacters(in: .whitespaces)
        if words.isEmpty || JS.test(words, #"^(?:(?:newer_than|older_than|after|before):\S+\s*)+$"#, options: .caseInsensitive) {
            throw ConnectError("failed", "Search with words from the project, people or the plan: never an empty search, or the period alone.")
        }
        let cap = min(max(1, Int((a["limit"]?.double ?? Double(Gmail.maxSearch)).rounded())), Gmail.maxSearch)
        let p = try browser()
        // The words in parentheses, so the period holds for all of them.
        let opened = try await p.open(Gmail.searchUrl(n, "(\(words))\(Gmail.period(within(nil)))"))
        if !JS.string(opened["url"]).hasPrefix("https://mail.google.com/") { throw ImportTools.gmailSignedOut() }
        let out = try await p.evaluate(Gmail.searchScript(limit: cap))
        if out["signedIn"] != .bool(true) { throw ImportTools.gmailSignedOut() }
        let ik = JS.test(JS.string(out["ik"]), Gmail.ikRE) ? JS.string(out["ik"]) : ""
        let clip: (JSONValue?, Int) -> String = { String(JS.replace(JS.string($0), #"\s+"#, " ").trimmingCharacters(in: .whitespaces).prefix($1)) }
        var threads: [JSONValue] = []
        for row in out["threads"]?.array ?? [] {
            let id = JS.replace(JS.string(row["id"]), "^#", "")
            if !JS.test(id, Gmail.threadIdRE) || threads.contains(where: { $0["id"]?.string == id }) { continue }
            let subject = clip(row["subject"], 300)
            threads.append(["id": .string(id), "subject": .string(subject.isEmpty ? "(no subject)" : subject), "people": .string(clip(row["people"], 300)), "date": .string(clip(row["date"], 80)),
                            "imported": .bool(!ik.isEmpty && imported.has("gmail:\(ik):\(id.dropFirst("thread-f:".count))"))])
        }
        log("Searched Gmail: \(threads.count) thread\(threads.count == 1 ? "" : "s")")
        var o: [String: JSONValue] = ["n": .number(Double(n)), "ik": .string(ik), "threads": .array(Array(threads.prefix(cap)))]
        if threads.count > cap { o["more"] = true }
        return .object(o)
    }

    func importGmailThreads(_ a: JSONValue) async throws -> JSONValue {
        let n = try Gmail.accountIndex(a["n"])
        let ik = JS.string(a["ik"])
        if !JS.test(ik, Gmail.ikRE) { throw ConnectError("failed", "ik must be the account key gmail_search returned") }
        let threads = a["threads"]?.array ?? []
        if threads.count > Gmail.maxThreadsACall { throw ConnectError("failed", "At most \(Gmail.maxThreadsACall) threads a call") }
        let fresh = threads.filter { JS.test(JS.string($0["id"]), Gmail.threadIdRE) && !imported.has("gmail:\(ik):\(JS.string($0["id"]).dropFirst("thread-f:".count))") }
        let before = session.gmailThreads()
        if before + fresh.count > Gmail.maxThreadsASession {
            throw ConnectError("failed", "At most \(Gmail.maxThreadsASession) Gmail threads a session, and \(before) came in already: bring in \(max(0, Gmail.maxThreadsASession - before)) more at most. Tell the person, and leave the rest for another session.")
        }
        let p = try browser()
        var count = 0
        var skipped: [JSONValue] = [], left: [JSONValue] = []
        let deadline = Time.ms() + Tools.callBudgetMs
        for thread in threads {
            let id = JS.string(thread["id"])
            if !JS.test(id, Gmail.threadIdRE) { skipped.append(["id": .string(id), "why": "not a Gmail thread id"]); continue }
            if Time.ms() > deadline { left.append(.string(id)); continue }
            let decimal = String(id.dropFirst("thread-f:".count))
            let key = "gmail:\(ik):\(decimal)"
            if imported.has(key) { skipped.append(["id": .string(id), "why": "brought in before"]); continue }
            do {
                let got = try await p.download(try Gmail.printUrl(n, ik: ik, id: id), dir: downloads("gmail"), name: "\(decimal).html", maxBytes: Tools.gmailMaxBytes, quiet: true)
                let html = (try? String(contentsOfFile: got.path, encoding: .utf8)) ?? ""
                try? FileManager.default.removeItem(atPath: got.path)
                if Gmail.signedOut(html) || JS.test(URL(string: got.url)?.host ?? "", #"(^|\.)accounts\.google\.com$"#) { throw ImportTools.gmailSignedOut() }
                if !JS.test(got.type, "html", options: .caseInsensitive) || !Gmail.isThreadPage(finalUrl: got.url, html: html) { throw ConnectError("failed", "Gmail sent no thread") }
                let read = Gmail.readThread(html)
                let subject = JS.string(thread["subject"]).trimmingCharacters(in: .whitespacesAndNewlines)
                let title = !subject.isEmpty ? subject : !read.subject.isEmpty ? read.subject : "Gmail thread"
                try await putNote(title: Names.sanitize(title), body: Names.clipMiddle(Gmail.threadNote(read), Tools.maxNoteChars), source: key,
                                  about: knows("Gmail", ["messages": .number(Double(read.messages.count)), "itemDate": Gmail.lastDay(read).map { .string($0) } ?? .null]))
                session.setGmailThreads(session.gmailThreads() + 1)
                count += 1
            } catch let e as ConnectError {
                if e.kind == "signed-out" { throw e }
                skipped.append(["id": .string(id), "why": .string(String(e.message.prefix(200)))])
            }
        }
        if count > 0 { log("Brought in \(count) Gmail thread\(count == 1 ? "" : "s")") }
        var o: [String: JSONValue] = ["added": .number(Double(count)), "skipped": ImportTools.skippedList(skipped), "skippedCount": .number(Double(skipped.count))]
        if !left.isEmpty { o["left"] = .array(left) }
        return .object(o)
    }

    // MARK: Overleaf

    func importOverleaf(_ ids: [String]) async throws -> JSONValue {
        let p = try browser()
        var count = 0
        var skipped: [JSONValue] = [], left: [JSONValue] = []
        let deadline = Time.ms() + Tools.callBudgetMs
        let approved = approvedFor(["Overleaf"])
        for id in ids.prefix(20) {
            if Time.ms() > deadline { left.append(.string(id)); continue }
            if !JS.test(id, Tools.overleafIdRE) { skipped.append(["id": .string(id), "why": "not an Overleaf project id"]); continue }
            if let approved, !approved.contains(id) { skipped.append(["id": .string(id), "why": .string(ImportTools.notApproved)]); continue }
            let key = "overleaf:\(id)"
            if imported.has(key) { skipped.append(["id": .string(id), "why": "brought in before"]); continue }
            do {
                let got = try await p.download("https://www.overleaf.com/project/\(id)/download/zip", dir: downloads("overleaf"), name: "", maxBytes: nil, quiet: true)
                let bytes = FileManager.default.contents(atPath: got.path) ?? Data()
                let magic = bytes.count >= 4 ? bytes.prefix(4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) } : 0
                if magic.littleEndian != 0x04034b50 {
                    try? FileManager.default.removeItem(atPath: got.path)
                    throw ConnectError("signed-out", "Overleaf sent no project: not signed in to Overleaf in Engelbart's browser. Call needs_you with kind \"signin\", then try again.")
                }
                var name = Names.sanitize(((got.path as NSString).lastPathComponent as NSString).deletingPathExtension)
                if name.isEmpty { name = "Overleaf \(id.prefix(6))" }
                let unpacked = try unzipInto(got.path, downloads("overleaf/\(name)"))
                try? FileManager.default.removeItem(atPath: got.path)
                let overleaf = knows("Overleaf", ["originUrl": .string("https://www.overleaf.com/project/\(id)"), "place": .string(name)])
                _ = try await addRow(unpacked.folder, "\(name) (Overleaf)", describe: false, about: overleaf)
                if let main = Tools.findMainTex(unpacked.folder) {
                    let tex = Names.clipMiddle((try? String(contentsOfFile: main, encoding: .utf8)) ?? "", 150_000)
                    try await putNote(title: Names.sanitize("\(name) (main.tex)"), body: "*Overleaf · https://www.overleaf.com/project/\(id)*\n\n```latex\n\(tex)\n```\n", source: "\(key):main", about: overleaf)
                }
                for pdf in ((try? FileManager.default.contentsOfDirectory(atPath: unpacked.folder)) ?? []).filter({ JS.test($0, #"\.pdf$"#, options: .caseInsensitive) }).sorted().prefix(3) {
                    _ = try await addFile((unpacked.folder as NSString).appendingPathComponent(pdf), "\(name): \((pdf as NSString).deletingPathExtension)", about: overleaf)
                }
                imported.add(key)
                count += 1
            } catch let e as ConnectError {
                if e.kind == "signed-out" { throw e }
                skipped.append(["id": .string(id), "why": .string(String(e.message.prefix(200)))])
            }
        }
        if count > 0 { log("Brought in \(count) Overleaf project\(count == 1 ? "" : "s")") }
        var o: [String: JSONValue] = ["added": .number(Double(count)), "skipped": ImportTools.skippedList(skipped), "skippedCount": .number(Double(skipped.count))]
        if !left.isEmpty { o["left"] = .array(left) }
        return .object(o)
    }

    // MARK: Zotero

    func importZotero(_ keys: [String]) async throws -> JSONValue {
        if keys.count > Tools.maxZoteroACall { throw ConnectError("failed", "At most \(Tools.maxZoteroACall) items a call") }
        let root = try await zoteroRoot()
        var count = 0, already = 0
        var skipped: [JSONValue] = []
        for key in keys {
            guard let item = zotero.itemOf(root, key) else { skipped.append(["key": .string(key), "why": "not in the library"]); continue }
            let source = "zotero:\(key)"
            if imported.has(source) { already += 1; continue }
            let title = String(JS.string(item["title"]).prefix(200))
            let place = zotero.collectionNames(root, item).joined(separator: ", ")
            let year = JS.test(JS.string(item["year"]), #"^\d{4}$"#) ? JS.string(item["year"]) : nil
            let day = dayOf(item["date"]?.string)
            let about = knows("Zotero", ["place": place.isEmpty ? .null : .string(place), "itemDate": day.isNull ? (year.map { .string($0) } ?? .null) : day])
            var out: JSONValue?
            do {
                let attachment = zotero.openableOf(item)
                let pdf = attachment?["contentType"]?.string == "application/pdf"
                let here = pdf ? zotero.localFile(root, attachment!) : nil
                if let here, here.source != "downloaded" { out = try await addRow(here.path, title, describe: false, about: about) }
                else if here != nil || (pdf && zotero.download != nil) {
                    var file = here?.path ?? ""
                    if here == nil { file = try await zotero.download!(JS.string(attachment?["key"]), JS.string(attachment?["filename"])) }
                    let doi = JS.string(item["doi"])
                    out = try await addFile(file, title, url: !doi.isEmpty ? "https://doi.org/\(doi)" : (item["url"]?.string.flatMap { $0.isEmpty ? nil : $0 }), about: about)
                } else if let doi = item["doi"]?.string, !doi.isEmpty { out = try await addRow("https://doi.org/\(doi)", title, describe: false, about: about) }
                else if let url = item["url"]?.string, !url.isEmpty { out = try await addRow(url, title, describe: false, about: about) }
                else { skipped.append(["key": .string(key), "why": "no pdf, DOI or link"]); continue }
            } catch { skipped.append(["key": .string(key), "why": .string((error as? ConnectError)?.message ?? error.localizedDescription)]); continue }
            imported.add(source)
            if out?["added"] == .bool(true) { count += 1 } else { already += 1 }
        }
        if count > 0 { log("Brought in \(count) paper\(count == 1 ? "" : "s") from Zotero") }
        return ["added": .number(Double(count)), "alreadyInLibrary": .number(Double(already)), "skipped": ImportTools.skippedList(skipped), "skippedCount": .number(Double(skipped.count))]
    }

    /// The Zotero mirror's folder; signed in but not synced yet, the sync is waited for (at most 180 s).
    func zoteroRoot() async throws -> String {
        guard let root = zotero.root() else { throw ConnectError("failed", "Zotero is not signed in. Call needs_you with kind \"signin\" and reason \"Sign in to Zotero\".") }
        let synced = { FileManager.default.fileExists(atPath: (root as NSString).appendingPathComponent("items.json")) }
        if synced() { return root }
        stateLock.lock()
        if zoteroWait == nil {
            log("Waiting for your Zotero library to sync")
            let limit = zotero.syncWaitMs ?? Tools.zoteroSyncWaitMs
            let ready = zotero.ready
            zoteroWait = Task {
                let started = Time.ms()
                let box = Box<JSONValue?>(nil)
                let readyTask = ready.map { r in Task { let s = await r(); box.set(s ?? ["state": "idle"]) } }
                while !synced() && box.get() == nil && Time.ms() - started < limit { try? await Task.sleep(nanoseconds: 250_000_000) }
                readyTask?.cancel()
                return box.get()
            }
        }
        let wait = zoteroWait!
        stateLock.unlock()
        let status = await wait.value
        stateLock.lock(); zoteroWait = nil; stateLock.unlock()
        if synced() { return root }
        if status?["state"]?.string == "error" {
            let detail = JS.string(status?["error"])
            throw ConnectError("failed", "Your Zotero library could not be synced\(detail.isEmpty ? "" : ": \(detail)"). The person is signed in: do not call needs_you for Zotero. Finish and say that Zotero's library could not be synced.")
        }
        throw ConnectError("failed", "Your Zotero library is still syncing from zotero.org. The person is signed in: do not call needs_you for Zotero. Try again in a minute.")
    }

    func appleNotesOf() throws -> AppleNotes {
        guard let appleNotes else { throw ConnectError("failed", "Apple Notes cannot be read here") }
        return appleNotes
    }

    // MARK: the memory question's chat (2026-10-12)

    func noteChat() {
        stateLock.lock(); defer { stateLock.unlock() }
        guard kind == "recall", let page, chat == nil, sent else { return }
        for app in WebChats.apps {
            if let id = WebChats.chatIdOf(app, page.url()) { chat = (app, id, false); asked(app, id); return }
        }
    }

    func forgetQuestion(_ app: String) async {
        noteChat()
        stateLock.lock()
        guard let c = chat, c.app == app, !c.done else { stateLock.unlock(); return }
        chat = (app, c.id, true)
        stateLock.unlock()
        do {
            _ = try await WebChats.delete(try browser(), app, c.id, question: question)
            log("Deleted the question from \(app)'s chats")
        } catch {
            log("Couldn't delete the question from \(app)'s chats: \((error as? ConnectError)?.message ?? error.localizedDescription)")
        }
    }
}

final class Box<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ value: T) { self.value = value }
    func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
}
