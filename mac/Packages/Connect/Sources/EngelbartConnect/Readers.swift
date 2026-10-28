import Foundation
import EngelbartCore

// Port of src/main/connect/readers.cjs (Connect your library, 2026-10-07; every library since 2026-10-08): what Engelbart
// reads on this Mac for the librarian's first look (Scan.swift) and the import agents' tools (Tools.swift). Everything
// here only reads; nothing is written except a private copy of a browser's History database (it is locked while the
// browser runs), deleted after the query.
//   folders      an overview (counts per top folder, the daily-notes folder), the note files under one
//   Obsidian     its vaults, from obsidian.json
//   AI chats     Claude Code (~/.claude/projects/*/*.jsonl) and Codex (~/.codex/sessions/**/rollout-*.jsonl) sessions,
//                and the conversations.json of a Claude or ChatGPT export, read as turns of text. Runs started by a
//                program are marked `automated` and left out unless asked for.
//   websites     a Chromium browser's history (top sites or pages) and bookmarks, and the links written in notes
//   Zotero       the collections and items of the mirror Engelbart keeps
//   PDFs         the folders that hold PDFs with counts, a few titles and a rough guess of what kind each holds
public enum Readers {
    public static let skipDirs: Set<String> = [".git", "node_modules", ".obsidian", ".trash", "__pycache__", ".venv", "venv", ".cache", ".Trash"]
    public static let noteExt: Set<String> = [".md", ".markdown", ".txt"]
    public static let imageExt: Set<String> = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic"]
    static let datedRE = #"^\d{4}-\d{2}-\d{2}"#
    static let dayMs = 86_400_000.0

    /// Tests set this to fix "now".
    nonisolated(unsafe) public static var now: () -> Date = { Date() }

    // MARK: helpers

    struct Stat { var isDir: Bool; var isFile: Bool; var mtimeMs: Double; var size: Int }
    static func statOf(_ file: String) -> Stat? {
        var st = Darwin.stat()
        guard fstatat(AT_FDCWD, file, &st, 0) == 0 else { return nil }
        let mode = st.st_mode & S_IFMT
        let ms = Double(st.st_mtimespec.tv_sec) * 1000 + Double(st.st_mtimespec.tv_nsec) / 1_000_000
        return Stat(isDir: mode == S_IFDIR, isFile: mode == S_IFREG, mtimeMs: ms, size: Int(st.st_size))
    }
    static func isDir(_ dir: String) -> Bool { statOf(dir)?.isDir == true }
    static func exists(_ file: String) -> Bool { access(file, F_OK) == 0 }
    static func join(_ parts: String...) -> String { parts.dropFirst().reduce(parts[0]) { ($0 as NSString).appendingPathComponent($1) } }
    static func ext(_ name: String) -> String { let e = (name as NSString).pathExtension; return e.isEmpty ? "" : "." + e.lowercased() }
    static func basename(_ p: String) -> String { (p as NSString).lastPathComponent }
    static func dirname(_ p: String) -> String { (p as NSString).deletingLastPathComponent }
    static func resolve(_ p: String) -> String { FolderAccess.resolve(p) }
    static func relative(_ root: String, _ file: String) -> String {
        if file == root { return "" }
        return file.hasPrefix(root + "/") ? String(file.dropFirst(root.count + 1)) : file
    }

    public static func shownPath(_ homeDir: String, _ file: String) -> String {
        !homeDir.isEmpty && file.hasPrefix(homeDir + "/") ? "~" + file.dropFirst(homeDir.count) : file
    }
    static func iso(_ ms: Double?) -> String? { guard let ms, ms.isFinite, ms > 0 else { return nil }; return Time.iso(Date(timeIntervalSince1970: ms / 1000)) }
    /// readers.cjs's clip (no trimEnd before the ellipsis).
    static func clip(_ text: String?, _ max: Int) -> String { Cursor.clip(text, max) }
    static func cutoff(_ days: Double?) -> Double { guard let days, days.isFinite, days > 0 else { return 0 }; return Time.ms(now()) - days * dayMs }
    static func readJSON(_ file: String) -> JSONValue? { Files.readJSON(URL(fileURLWithPath: file)) }

    /// `~/x` or an absolute path → absolute; anything else nil.
    public static func expandPath(_ homeDir: String, _ value: String?) -> String? {
        let raw = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return nil }
        if raw == "~" || raw.hasPrefix("~/") { return resolve(homeDir + raw.dropFirst()) }
        return raw.hasPrefix("/") ? resolve(raw) : nil
    }

    struct Entry { var name: String; var isDir: Bool; var isFile: Bool }
    static func entries(_ dir: String) -> [Entry]? {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return nil }
        return names.map { name in
            let full = (dir as NSString).appendingPathComponent(name)
            var st = Darwin.stat()
            // withFileTypes reports the entry itself (lstat): a symlink is neither a file nor a folder.
            guard lstat(full, &st) == 0 else { return Entry(name: name, isDir: false, isFile: false) }
            let mode = st.st_mode & S_IFMT
            return Entry(name: name, isDir: mode == S_IFDIR, isFile: mode == S_IFREG)
        }
    }

    /// Every file under `dir` (dot folders and skipDirs passed over), breadth first, at most `max` entries; true when cut.
    /// `readable` (MATH-110): a folder it says no to is not looked into.
    @discardableResult
    public static func walkFiles(_ dir: String, max: Int = 20000, readable: ((String) -> Bool)? = nil, _ visit: (String, String) -> Void) -> Bool {
        if let readable, !readable(dir) { return false }
        var queue = [dir]
        var seen = 0
        var head = 0
        while head < queue.count {
            let here = queue[head]; head += 1
            guard let list = entries(here) else { continue }
            for entry in list {
                if entry.name == ".DS_Store" { continue }
                seen += 1
                if seen > max { return true }
                let full = (here as NSString).appendingPathComponent(entry.name)
                if entry.isDir {
                    if !skipDirs.contains(entry.name) && !entry.name.hasPrefix(".") && (readable?(full) ?? true) { queue.append(full) }
                    continue
                }
                if entry.isFile { visit(full, entry.name) }
            }
        }
        return false
    }

    // MARK: folders

    /// The folder Obsidian's Daily notes plugin writes to, relative to the vault, or ''.
    public static func obsidianDailyFolder(_ vault: String) -> String {
        for file in ["daily-notes.json", "plugins/periodic-notes/data.json"] {
            guard let value = readJSON(join(vault, ".obsidian", file)) else { continue }
            let folder = JS.truthy(value["folder"]) ? value["folder"] : value["daily"]?["folder"]
            if let f = folder?.string, !f.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return JS.replace(f.trimmingCharacters(in: .whitespacesAndNewlines), "^/+|/+$", "")
            }
        }
        return ""
    }

    /// A folder at a glance: how many notes, pdfs and pictures it holds, and the same for each folder at its top (most
    /// notes first), with how many of a folder's notes are named by date (`dated`, 0–1).
    public static func folderOverview(_ dir: String, homeDir: String = NSHomeDirectory(), max: Int = 20000, top: Int = 30, readable: ((String) -> Bool)? = nil) -> JSONValue {
        let root = resolve(dir)
        var files = 0, notes = 0, pdfs = 0, images = 0
        var newest = 0.0
        struct Folder { var name: String; var files = 0; var notes = 0; var pdfs = 0; var images = 0; var dated = 0; var newest = 0.0 }
        var folders: [String: Folder] = [:]
        var order: [String] = []
        var rootNotes = 0
        let truncated = walkFiles(root, max: max, readable: readable) { file, name in
            let e = ext(name)
            let rel = relative(root, file)
            let head = rel.contains("/") ? String(rel.split(separator: "/")[0]) : nil
            let kind = noteExt.contains(e) ? "notes" : e == ".pdf" ? "pdfs" : imageExt.contains(e) ? "images" : nil
            let mtime = statOf(file)?.mtimeMs ?? 0
            files += 1
            switch kind { case "notes": notes += 1; case "pdfs": pdfs += 1; case "images": images += 1; default: break }
            newest = Swift.max(newest, mtime)
            guard let head else { if kind == "notes" { rootNotes += 1 }; return }
            if folders[head] == nil { folders[head] = Folder(name: head); order.append(head) }
            folders[head]!.files += 1
            switch kind { case "notes": folders[head]!.notes += 1; case "pdfs": folders[head]!.pdfs += 1; case "images": folders[head]!.images += 1; default: break }
            if kind == "notes" && JS.test(name, datedRE) { folders[head]!.dated += 1 }
            folders[head]!.newest = Swift.max(folders[head]!.newest, mtime)
        }
        let list = order.compactMap { folders[$0] }.map { f -> (Folder, Double) in
            (f, f.notes > 0 ? (Double(f.dated) / Double(f.notes) * 100).rounded() / 100 : 0)
        }.sorted { a, b in
            if a.0.notes != b.0.notes { return a.0.notes > b.0.notes }
            if a.0.files != b.0.files { return a.0.files > b.0.files }
            return a.0.name < b.0.name
        }
        let setting = exists(join(root, ".obsidian")) ? obsidianDailyFolder(root) : ""
        let guessed = list.first { $0.0.notes >= 5 && $0.1 >= 0.6 }
        let folderJSON: [JSONValue] = list.prefix(top).map { f, dated in
            ["name": .string(f.name), "files": .number(Double(f.files)), "notes": .number(Double(f.notes)), "pdfs": .number(Double(f.pdfs)),
             "images": .number(Double(f.images)), "dated": .number(dated), "newest": iso(f.newest).map { .string($0) } ?? .null]
        }
        return ["path": .string(root), "shown": .string(shownPath(homeDir, root)), "files": .number(Double(files)), "notes": .number(Double(notes)),
                "pdfs": .number(Double(pdfs)), "images": .number(Double(images)), "newest": iso(newest).map { .string($0) } ?? .null,
                "rootNotes": .number(Double(rootNotes)), "dailyFolder": .string(setting.isEmpty ? (guessed?.0.name ?? "") : setting),
                "folders": .array(folderJSON), "moreFolders": .number(Double(Swift.max(0, list.count - top))), "truncated": .bool(truncated)]
    }

    static func norm(_ list: [String]) -> [String] { list.map { JS.replace($0, "^/+|/+$", "") }.filter { !$0.isEmpty } }
    static func under(_ rel: String, _ folder: String) -> Bool { rel == folder || rel.hasPrefix(folder + "/") }

    /// The note files (.md, .markdown, .txt) under `dir`: only inside `include`, never inside `exclude`, changed since
    /// `days` ago when given. Absolute paths, at most `max`, newest first.
    public static func noteFiles(_ dir: String, include: [String] = [], exclude: [String] = [], days: Double? = nil, max: Int = 2000, readable: ((String) -> Bool)? = nil) -> [String] {
        let root = resolve(dir)
        let ins = norm(include), outs = norm(exclude)
        let since = cutoff(days)
        var found: [(String, Double)] = []
        walkFiles(root, max: 200_000, readable: readable) { file, name in
            guard noteExt.contains(ext(name)) else { return }
            let rel = relative(root, file)
            if !ins.isEmpty && !ins.contains(where: { under(rel, $0) }) { return }
            if outs.contains(where: { under(rel, $0) }) { return }
            guard let st = statOf(file), !(since > 0 && st.mtimeMs < since) else { return }
            found.append((file, st.mtimeMs))
        }
        return found.enumerated().sorted { $0.element.1 != $1.element.1 ? $0.element.1 > $1.element.1 : $0.offset < $1.offset }.prefix(max).map { $0.element.0 }
    }

    // MARK: Obsidian

    public struct Vault: Sendable, Equatable { public var name: String; public var path: String; public var shown: String; public var open: Bool; public var lastOpened: String? }

    /// The vaults Obsidian knows on this Mac that are still there, the one opened last first.
    public static func obsidianVaults(_ homeDir: String = NSHomeDirectory()) -> [Vault] {
        guard let config = readJSON(join(homeDir, "Library/Application Support/obsidian/obsidian.json")) else { return [] }
        return (config["vaults"]?.object ?? [:]).values.compactMap { vault -> Vault? in
            guard let p = vault["path"]?.string, isDir(p) else { return nil }
            let ts = vault["ts"]?.double ?? Double(JS.string(vault["ts"])) ?? .nan
            return Vault(name: basename(p), path: p, shown: shownPath(homeDir, p), open: JS.truthy(vault["open"]), lastOpened: iso(ts))
        }.sorted { ($0.lastOpened ?? "null") > ($1.lastOpened ?? "null") }
    }

    // MARK: AI chats

    // "The number of chats is too low" (2026-10-13): a session whose first prompt came after its head is read on, a part
    // at a time, until what is wanted is found or scanMax bytes have been read.
    static let scanPart = 256 * 1024
    static let scanMax = 8 * 1024 * 1024

    /// `visit(line)` for each line of `file` from its start, until it returns true or `max` bytes were read.
    static func scanLines(_ file: String, max: Int = scanMax, _ visit: (String) -> Bool) {
        guard let handle = FileHandle(forReadingAtPath: file) else { return }
        defer { try? handle.close() }
        var at = 0
        var rest = Data()
        while at < max {
            guard let chunk = try? handle.read(upToCount: scanPart), !chunk.isEmpty else { break }
            at += chunk.count
            var buffer = rest + chunk
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self)
                buffer = Data(buffer[buffer.index(after: nl)...])
                if visit(line) { return }
            }
            rest = buffer
        }
        if !rest.isEmpty && at < max { _ = visit(String(decoding: rest, as: UTF8.self)) }
    }

    static func parse(_ line: String) -> JSONValue? { try? JSONValue.parse(line) }

    /// A prompt a person typed, not one a command or a hook wrote (those start with a tag) nor a caveat Claude Code adds.
    static func typed(_ text: String?) -> Bool {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return !JS.test(text, #"^\s*<"#) && !text.hasPrefix("Caveat: ")
    }
    static func textOf(_ content: JSONValue?) -> String {
        if let s = content?.string { return s }
        guard let parts = content?.array else { return "" }
        return parts.filter { p in ["text", "input_text", "output_text"].contains(p["type"]?.string ?? "") && p["text"]?.string != nil }.map { $0["text"]!.string! }.joined(separator: "\n")
    }

    public static func claudeCodeRoot(_ homeDir: String) -> String { join(homeDir, ".claude/projects") }
    public static func codexRoot(_ homeDir: String, _ env: [String: String]) -> String {
        join(env["CODEX_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? join(homeDir, ".codex"), "sessions")
    }
    static let claudeIdRE = #"^[\w.-]{1,255}/[\w-]{1,80}$"#
    static let codexIdRE = #"^\d{4}/\d{2}/\d{2}/rollout-[\w.:-]{1,120}$"#

    struct SessionFile { var id: String; var file: String; var mtime: Double; var size: Int }

    static func claudeCodeFiles(_ homeDir: String) -> [SessionFile] {
        let root = claudeCodeRoot(homeDir)
        var out: [SessionFile] = []
        for dir in (entries(root) ?? []) where dir.isDir {
            for name in (try? FileManager.default.contentsOfDirectory(atPath: join(root, dir.name))) ?? [] where name.hasSuffix(".jsonl") {
                let file = join(root, dir.name, name)
                if let st = statOf(file), st.isFile { out.append(SessionFile(id: "\(dir.name)/\(name.dropLast(6))", file: file, mtime: st.mtimeMs, size: st.size)) }
            }
        }
        return out.sorted { $0.mtime > $1.mtime }
    }

    static func codexFiles(_ homeDir: String, _ env: [String: String]) -> [SessionFile] {
        let root = codexRoot(homeDir, env)
        var out: [SessionFile] = []
        walkFiles(root, max: 100_000) { file, name in
            guard name.hasPrefix("rollout-"), name.hasSuffix(".jsonl"), let st = statOf(file) else { return }
            out.append(SessionFile(id: String(relative(root, file).dropLast(6)), file: file, mtime: st.mtimeMs, size: st.size))
        }
        return out.sorted { $0.mtime > $1.mtime }
    }

    struct Head { var title: String; var first: String; var project: String; var automated: Bool }

    /// A Claude Code session's head. Its title is the one named for it (`custom-title`, then `ai-title`), else its summary,
    /// else its first prompt. `automated`: a sidechain, or a `claude -p` run (entrypoint sdk-cli); a session an app ran on
    /// the Agent SDK for the person (sdk-ts, sdk-py) is theirs (2026-10-13).
    static func claudeCodeHead(_ file: String) -> Head {
        var first = "", summary = "", project = "", entry = "", named = "", aiTitle = ""
        var sidechain = false, after = 0
        scanLines(file) { line in
            guard let event = parse(line), case .object = event else { return false }
            if project.isEmpty, let cwd = event["cwd"]?.string { project = cwd }
            if entry.isEmpty, let e = event["entrypoint"]?.string { entry = e }
            if event["isSidechain"] == .bool(true) { sidechain = true }
            let type = event["type"]?.string
            if type == "summary", let s = event["summary"]?.string, summary.isEmpty { summary = s }
            if type == "custom-title", let t = event["customTitle"]?.string, !t.trimmingCharacters(in: .whitespaces).isEmpty { named = t }
            if type == "ai-title", let t = event["aiTitle"]?.string, !t.trimmingCharacters(in: .whitespaces).isEmpty { aiTitle = t }
            if first.isEmpty, type == "user", !JS.truthy(event["isMeta"]), event["message"]?["role"]?.string == "user" {
                let content = event["message"]?["content"]
                let text = textOf(content)
                let toolResult = content?.array?.contains { $0["type"]?.string == "tool_result" } ?? false
                if typed(text) && !toolResult { first = text }
            }
            // The title records come a little after the first prompt, when they come at all.
            if !first.isEmpty && !project.isEmpty && !entry.isEmpty { after += 1 }
            return !first.isEmpty && !project.isEmpty && !entry.isEmpty && (!named.isEmpty || !aiTitle.isEmpty || after > 400)
        }
        let title = !named.isEmpty ? named : !aiTitle.isEmpty ? aiTitle : !summary.isEmpty ? summary : first
        return Head(title: clip(title, 120), first: clip(first, 300), project: project, automated: entry == "sdk-cli" || sidechain)
    }

    // What Codex itself writes as a user message (not the person).
    static let codexInjected = #"^\s*<(turn_aborted|environment_context|user_instructions|user_shell_command|subagent_notification|permissions|collaboration_mode|developer)\b"#

    /// A Codex session's head. A `user_message` event is what the person typed, even when it begins with "<", unless it
    /// is one Codex writes itself.
    static func codexHead(_ file: String) -> Head {
        var first = "", project = "", automated = false
        scanLines(file) { line in
            guard let event = parse(line), let payload = event["payload"], JS.truthy(payload) else { return false }
            let type = event["type"]?.string
            if type == "session_meta" {
                project = JS.string(payload["cwd"])
                let source = payload["source"]
                automated = payload["originator"]?.string == "codex_exec" || source?.string == "exec" || (source?.object != nil && JS.truthy(source?["subagent"]))
            }
            if first.isEmpty, type == "event_msg", payload["type"]?.string == "user_message", let m = payload["message"]?.string,
               !m.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !JS.test(m, codexInjected) { first = m }
            if first.isEmpty, type == "response_item", payload["type"]?.string == "message", payload["role"]?.string == "user" {
                let text = textOf(payload["content"])
                if typed(text) { first = text }
            }
            return !first.isEmpty && !project.isEmpty
        }
        return Head(title: clip(first, 120), first: clip(first, 300), project: project, automated: automated)
    }

    static func matches(_ title: String, _ first: String, _ project: String, _ query: String) -> Bool {
        let words = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let hay = "\(title) \(first) \(project)".lowercased()
        return words.allSatisfy { hay.contains($0) }
    }

    public struct LocalChat: Sendable, Equatable { public var id: String; public var title: String; public var first: String; public var project: String; public var date: String?; public var size: Int
        public var json: JSONValue { ["id": .string(id), "title": .string(title), "first": .string(first), "project": .string(project), "date": date.map { .string($0) } ?? .null, "size": .number(Double(size))] }
    }

    /// Kept 60 s per (app, options) inside the scanner (scan-child.cjs): the detect → digest → tool evidence of one
    /// onboarding reads the session files once. Off by default (the tools read fresh, as in Electron's main process).
    nonisolated(unsafe) static var chatCache: [String: (at: Double, value: [LocalChat])]? = nil
    static let chatCacheLock = NSLock()
    public static func keepLocalChats(_ on: Bool) { chatCacheLock.lock(); chatCache = on ? (chatCache ?? [:]) : nil; chatCacheLock.unlock() }

    /// Claude Code's or Codex's sessions on this Mac, newest first.
    public static func localChats(_ app: String, homeDir: String = NSHomeDirectory(), env: [String: String] = ProcessInfo.processInfo.environment,
                                  days: Double? = nil, project: String = "", query: String = "", limit: Int = 200, automated: Bool = false) -> [LocalChat] {
        let key = [app, homeDir, env["CODEX_HOME"] ?? "", days.map { String($0) } ?? "", project, query, String(limit), String(automated)].joined(separator: "\u{1}")
        chatCacheLock.lock()
        if let hit = chatCache?[key], Time.ms() - hit.at < 60_000 { chatCacheLock.unlock(); return hit.value }
        chatCacheLock.unlock()
        let files = app == "Codex" ? codexFiles(homeDir, env) : claudeCodeFiles(homeDir)
        let since = cutoff(days)
        var out: [LocalChat] = []
        for entry in files {
            if since > 0 && entry.mtime < since { break }
            let head = app == "Codex" ? codexHead(entry.file) : claudeCodeHead(entry.file)
            if head.first.isEmpty && head.title.isEmpty { continue }
            if head.automated && !automated { continue }
            let row = LocalChat(id: entry.id, title: head.title, first: head.first, project: shownPath(homeDir, head.project), date: iso(entry.mtime), size: entry.size)
            if !project.isEmpty && !row.project.lowercased().contains(project.lowercased()) { continue }
            if !query.isEmpty && !matches(row.title, row.first, row.project, query) { continue }
            out.append(row)
            if out.count >= limit { break }
        }
        chatCacheLock.lock()
        if chatCache != nil { chatCache![key] = (Time.ms(), out) }
        chatCacheLock.unlock()
        return out
    }

    /// How many sessions an app has, how many in the last 30 and 180 days (and in the period), and the newest.
    public static func localChatCounts(_ app: String, homeDir: String = NSHomeDirectory(), env: [String: String] = ProcessInfo.processInfo.environment, days: Double? = nil) -> [String: JSONValue] {
        let files = app == "Codex" ? codexFiles(homeDir, env) : claudeCodeFiles(homeDir)
        let d30 = cutoff(30), d180 = cutoff(180), since = cutoff(days)
        var out: [String: JSONValue] = ["total": .number(Double(files.count)), "last30Days": .number(Double(files.filter { $0.mtime >= d30 }.count)),
                                        "last180Days": .number(Double(files.filter { $0.mtime >= d180 }.count)), "newest": iso(files.first?.mtime).map { .string($0) } ?? .null]
        if since > 0 { out["inPeriod"] = .number(Double(files.filter { $0.mtime >= since }.count)) }
        return out
    }

    /// The file a local session's id names, or nil (ids are only ever the shapes the listing gives).
    public static func localChatFile(_ app: String, _ id: String, homeDir: String = NSHomeDirectory(), env: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        if app == "Codex" {
            guard JS.test(id, codexIdRE) else { return nil }
            let file = join(codexRoot(homeDir, env), "\(id).jsonl")
            return statOf(file) != nil ? file : nil
        }
        guard JS.test(id, claudeIdRE), !id.contains("..") else { return nil }
        let file = join(claudeCodeRoot(homeDir), "\(id).jsonl")
        return statOf(file) != nil ? file : nil
    }

    public struct Turn: Sendable, Equatable { public var role: String; public var text: String
        public var json: JSONValue { ["role": .string(role), "text": .string(text)] } }
    public struct Transcript: Sendable, Equatable { public var title: String; public var project: String; public var date: String?; public var turns: [Turn] }

    static func pushTurn(_ turns: inout [Turn], _ role: String, _ text: String?) {
        let value = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return }
        if let last = turns.last, last.role == role { turns[turns.count - 1].text = "\(last.text)\n\n\(value)" } else { turns.append(Turn(role: role, text: value)) }
    }

    /// A local session read as turns of text (tool calls, thinking and tool output left out).
    public static func localTranscript(_ app: String, _ id: String, homeDir: String = NSHomeDirectory(), env: [String: String] = ProcessInfo.processInfo.environment) throws -> Transcript {
        guard let file = localChatFile(app, id, homeDir: homeDir, env: env) else { throw ConnectError("failed", "No \(app) session \(id)") }
        let head = app == "Codex" ? codexHead(file) : claudeCodeHead(file)
        var turns: [Turn] = []
        let text = (try? String(contentsOfFile: file, encoding: .utf8)) ?? String(decoding: FileManager.default.contents(atPath: file) ?? Data(), as: UTF8.self)
        let events = text.components(separatedBy: "\n").compactMap(parse)
        if app == "Codex" {
            let withPayload = events.filter { JS.truthy($0["payload"]) }
            let clean = withPayload.contains { $0["type"]?.string == "event_msg" && ["user_message", "agent_message"].contains($0["payload"]?["type"]?.string ?? "") }
            for event in withPayload {
                let payload = event["payload"]!
                if clean && event["type"]?.string == "event_msg" {
                    if payload["type"]?.string == "user_message" && typed(payload["message"]?.string) { pushTurn(&turns, "user", payload["message"]?.string) }
                    if payload["type"]?.string == "agent_message" { pushTurn(&turns, "assistant", JS.string(payload["message"])) }
                } else if !clean && event["type"]?.string == "response_item" && payload["type"]?.string == "message" {
                    let t = textOf(payload["content"])
                    if payload["role"]?.string == "assistant" { pushTurn(&turns, "assistant", t) } else if payload["role"]?.string == "user" && typed(t) { pushTurn(&turns, "user", t) }
                }
            }
        } else {
            for event in events {
                guard case .object = event, !JS.truthy(event["isMeta"]), !JS.truthy(event["isSidechain"]), let message = event["message"], JS.truthy(message) else { continue }
                let content = message["content"]
                if event["type"]?.string == "user" && !(content?.array?.contains { $0["type"]?.string == "tool_result" } ?? false) {
                    let t = textOf(content)
                    if typed(t) { pushTurn(&turns, "user", t) }
                } else if event["type"]?.string == "assistant" {
                    pushTurn(&turns, "assistant", textOf(content))
                }
            }
        }
        return Transcript(title: head.title.isEmpty ? "Untitled session" : head.title, project: shownPath(homeDir, head.project), date: iso(statOf(file)?.mtimeMs), turns: turns)
    }

    // MARK: Claude and ChatGPT exports

    public struct ExportChat: Sendable, Equatable { public var id: String; public var title: String; public var created: Double; public var updated: Double; public var turns: [Turn] }

    nonisolated(unsafe) static var exportCache: [String: (mtime: Double, chats: [ExportChat])] = [:]
    static let exportLock = NSLock()

    /// The conversations.json an export holds: the file itself, inside a folder, or inside a .zip (read with unzip).
    static func exportText(_ file: String) throws -> String {
        guard let st = statOf(file) else { throw ConnectError("failed", "Nothing is at \(file)") }
        if st.isDir {
            let inside = join(file, "conversations.json")
            guard statOf(inside) != nil else { throw ConnectError("failed", "No conversations.json in \(file)") }
            return (try? String(contentsOfFile: inside, encoding: .utf8)) ?? ""
        }
        if JS.test(file, #"\.zip$"#, options: .caseInsensitive) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
            p.arguments = ["-p", file, "conversations.json"]
            let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
            do { try p.run() } catch { throw ConnectError("failed", "No conversations.json in \(basename(file))") }
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            guard p.terminationStatus == 0 else { throw ConnectError("failed", "No conversations.json in \(basename(file))") }
            return String(decoding: data, as: UTF8.self)
        }
        return (try? String(contentsOfFile: file, encoding: .utf8)) ?? ""
    }

    static func seconds(_ value: JSONValue?) -> Double {
        if let n = value?.double { return n * 1000 }
        if let s = value?.string, let d = Time.parse(s) ?? Gmail.dateOf(s).map({ Date(timeIntervalSince1970: $0 / 1000) }) { return Time.ms(d) }
        return 0
    }

    /// One conversation of either export (or of web-chats' answers).
    public static func exportChat(_ entry: JSONValue) -> ExportChat? {
        if let messages = entry["chat_messages"]?.array { // Claude
            let turns = messages.map { m -> Turn in
                let text = JS.truthy(m["text"]) ? JS.string(m["text"]) : textOf(m["content"])
                return Turn(role: m["sender"]?.string == "human" ? "user" : "assistant", text: text.trimmingCharacters(in: .whitespacesAndNewlines))
            }.filter { !$0.text.isEmpty }
            return ExportChat(id: JS.string(entry["uuid"]), title: JS.string(entry["name"]).trimmingCharacters(in: .whitespacesAndNewlines),
                              created: seconds(entry["created_at"]), updated: seconds(entry["updated_at"]), turns: turns)
        }
        if let mapping = entry["mapping"]?.object { // ChatGPT: the branch that ends at current_node
            var chain: [JSONValue] = []
            var at = entry["current_node"]?.string
            var guardSet = Set<String>()
            while let node = at, let value = mapping[node], !guardSet.contains(node) {
                guardSet.insert(node); chain.append(value); at = value["parent"]?.string
            }
            let turns = chain.reversed().compactMap { $0["message"] }.filter { m in
                let role = m["author"]?["role"]?.string
                return (role == "user" || role == "assistant") && m["content"]?["parts"]?.array != nil
            }.map { m in
                Turn(role: m["author"]!["role"]!.string!, text: (m["content"]!["parts"]!.array!).compactMap(\.string).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines))
            }.filter { !$0.text.isEmpty }
            let id = JS.truthy(entry["conversation_id"]) ? JS.string(entry["conversation_id"]) : JS.string(entry["id"])
            return ExportChat(id: id, title: JS.string(entry["title"]).trimmingCharacters(in: .whitespacesAndNewlines),
                              created: seconds(entry["create_time"]), updated: seconds(entry["update_time"]), turns: turns)
        }
        return nil
    }

    public static func readExport(_ file: String) throws -> [ExportChat] {
        let st = statOf(file)
        exportLock.lock()
        if let held = exportCache[file], let st, held.mtime == st.mtimeMs { exportLock.unlock(); return held.chats }
        exportLock.unlock()
        let value: JSONValue
        do { value = try JSONValue.parse(try exportText(file)) } catch let e as ConnectError where JS.test(e.message, "No conversations|Nothing is at") { throw e } catch {
            throw ConnectError("failed", "\(basename(file)) is not a Claude or ChatGPT export")
        }
        guard let list = value.array else { throw ConnectError("failed", "\(basename(file)) is not a Claude or ChatGPT export") }
        let chats = list.compactMap(exportChat).filter { !$0.id.isEmpty && !$0.turns.isEmpty }.enumerated().sorted { $0.element.updated != $1.element.updated ? $0.element.updated > $1.element.updated : $0.offset < $1.offset }.map(\.element)
        exportLock.lock()
        exportCache = [file: (st?.mtimeMs ?? 0, chats)] // one export held at a time: they can be large
        exportLock.unlock()
        return chats
    }

    /// An export's conversations, newest first.
    public static func exportChats(_ file: String, days: Double? = nil, query: String = "", limit: Int = 200) throws -> [JSONValue] {
        let since = cutoff(days)
        var out: [JSONValue] = []
        for chat in try readExport(file) {
            if since > 0 && chat.updated < since { break }
            let first = chat.turns.first { $0.role == "user" }?.text ?? ""
            let title = clip(chat.title.isEmpty ? first : chat.title, 120)
            if !query.isEmpty && !matches(title, clip(first, 300), "", query) { continue }
            out.append(["id": .string(chat.id), "title": .string(title), "first": .string(clip(first, 300)), "project": "",
                        "date": iso(chat.updated > 0 ? chat.updated : chat.created).map { .string($0) } ?? .null, "turns": .number(Double(chat.turns.count))])
            if out.count >= limit { break }
        }
        return out
    }

    public static func exportCounts(_ file: String) throws -> JSONValue {
        let chats = try readExport(file)
        let d30 = cutoff(30), d180 = cutoff(180)
        return ["total": .number(Double(chats.count)), "last30Days": .number(Double(chats.filter { $0.updated >= d30 }.count)),
                "last180Days": .number(Double(chats.filter { $0.updated >= d180 }.count)),
                "newest": iso(chats.first?.updated).map { .string($0) } ?? .null, "oldest": iso(chats.last?.updated ?? 0).map { .string($0) } ?? .null]
    }

    public static func exportTranscript(_ file: String, _ id: String) throws -> Transcript {
        guard let chat = try readExport(file).first(where: { $0.id == id }) else { throw ConnectError("failed", "No conversation \(id) in the export") }
        let title = !chat.title.isEmpty ? chat.title : (clip(chat.turns.first?.text, 80).isEmpty ? "Untitled conversation" : clip(chat.turns.first?.text, 80))
        return Transcript(title: title, project: "", date: iso(chat.updated > 0 ? chat.updated : chat.created), turns: chat.turns)
    }

    // MARK: websites

    static let chromium: [(String, [String])] = [("Chrome", ["Google", "Chrome"]), ("Arc", ["Arc", "User Data"]), ("Brave", ["BraveSoftware", "Brave-Browser"]),
                                                 ("Edge", ["Microsoft Edge"]), ("Chromium", ["Chromium"]), ("Vivaldi", ["Vivaldi"]),
                                                 ("Opera", ["com.operasoftware.Opera"]), ("Comet", ["Comet"])]

    public struct BrowserProfile: Sendable, Equatable { public var browser: String; public var profile: String; public var name: String; public var dir: String; public var used: String? }

    /// The Chromium browsers' profiles on this Mac that have a history or bookmarks, the one used last first.
    public static func browserProfiles(_ homeDir: String = NSHomeDirectory()) -> [BrowserProfile] {
        var out: [BrowserProfile] = []
        for (browser, parts) in chromium {
            let base = parts.reduce(join(homeDir, "Library/Application Support")) { join($0, $1) }
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: base) else { continue }
            let info = readJSON(join(base, "Local State"))?["profile"]?["info_cache"]
            for name in names.sorted() where name == "Default" || JS.test(name, #"^Profile \d+$"#) {
                let dir = join(base, name)
                let history = statOf(join(dir, "History"))
                if history != nil || statOf(join(dir, "Bookmarks")) != nil {
                    let shown = info?[name]?["name"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? name
                    out.append(BrowserProfile(browser: browser, profile: name, name: clip(shown, 60), dir: dir, used: iso(history?.mtimeMs ?? 0)))
                }
            }
        }
        return out.enumerated().sorted { ($0.element.used ?? "null") != ($1.element.used ?? "null") ? ($0.element.used ?? "null") > ($1.element.used ?? "null") : $0.offset < $1.offset }.map(\.element)
    }

    /// The profile a tool call names ({ browser, profile }), else the first found.
    public static func profileOf(_ homeDir: String, browser: String = "", profile: String = "") -> BrowserProfile? {
        browserProfiles(homeDir).first { (browser.isEmpty || $0.browser.lowercased() == browser.lowercased()) && (profile.isEmpty || $0.profile == profile) }
    }

    public static func hostOf(_ url: String) -> String {
        guard let host = URL(string: url)?.host, !host.isEmpty else { return "" }
        return JS.replace(host.lowercased(), #"^www\."#, "")
    }
    /// Chrome counts microseconds from 1601-01-01.
    public static func chromeTime(_ ms: Double) -> Double { ((ms / 1000 + 11_644_473_600) * 1e6).rounded() }
    static func fromChromeTime(_ value: Double) -> Double { value > 0 ? value / 1000 - 11_644_473_600_000 : 0 }

    /// A browser profile's most visited pages since `days` ago, grouped by site (`by` 'site') or as pages ('page').
    public static func browserHistory(_ dir: String, days: Double = 90, limit: Int = 50, by: String = "site", exclude: [String] = []) throws -> [JSONValue] {
        let source = join(dir, "History")
        guard statOf(source) != nil else { throw ConnectError("failed", "This browser profile has no history") }
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("engelbart-history-\(UUID().uuidString.prefix(8))").path
        try? FileManager.default.createDirectory(atPath: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: scratch) }
        let copy = join(scratch, "History")
        do {
            try FileManager.default.copyItem(atPath: source, toPath: copy)
            if statOf(source + "-wal") != nil { try FileManager.default.copyItem(atPath: source + "-wal", toPath: copy + "-wal") }
        } catch { throw ConnectError("failed", "The browser history could not be read") }
        let since = chromeTime(cutoff(days))
        let rows: [[String: SQLiteReader.Value]]
        do {
            let db = try SQLiteReader(path: copy)
            defer { db.close() }
            rows = try db.all("SELECT url, title, visit_count AS visits, last_visit_time AS last FROM urls WHERE hidden = 0 AND last_visit_time > \(Int64(since)) ORDER BY visit_count DESC LIMIT 5000;")
        } catch { throw ConnectError("failed", "The browser history could not be read") }
        let skip = Set(exclude.map { JS.replace($0.lowercased(), #"^www\."#, "") })
        let kept = rows.filter { row in
            let url = row["url"]?.string ?? ""
            guard JS.test(url, "^https?:", options: .caseInsensitive) else { return false }
            let host = hostOf(url)
            return !host.isEmpty && !skip.contains(host) && !skip.contains { host.hasSuffix(".\($0)") }
        }
        if by == "page" {
            return kept.prefix(limit).map { row in
                ["url": .string(row["url"]?.string ?? ""), "title": .string(clip(row["title"]?.string, 160)), "visits": .number(Double(row["visits"]?.int ?? 0)),
                 "last": iso(fromChromeTime(row["last"]?.double ?? 0)).map { .string($0) } ?? .null]
            }
        }
        var sites: [String: (visits: Double, pages: Int, title: String, url: String)] = [:]
        var order: [String] = []
        for row in kept {
            let url = row["url"]?.string ?? ""
            let host = hostOf(url)
            if sites[host] == nil { sites[host] = (0, 0, clip(row["title"]?.string, 160), url); order.append(host) }
            sites[host]!.visits += Double(row["visits"]?.int ?? 0)
            sites[host]!.pages += 1
        }
        return order.enumerated().sorted { sites[$0.element]!.visits != sites[$1.element]!.visits ? sites[$0.element]!.visits > sites[$1.element]!.visits : $0.offset < $1.offset }
            .prefix(limit).map { host in
                let s = sites[host.element]!
                return ["host": .string(host.element), "visits": .number(s.visits), "pages": .number(Double(s.pages)), "title": .string(s.title), "url": .string(s.url)]
            }
    }

    /// A browser profile's bookmarks → [{ title, url, folder }].
    public static func browserBookmarks(_ dir: String, limit: Int = 2000) -> [JSONValue] {
        guard let value = readJSON(join(dir, "Bookmarks")) else { return [] }
        var out: [JSONValue] = []
        func visit(_ node: JSONValue?, _ folder: String) {
            guard let node, case .object = node, out.count < limit else { return }
            if node["type"]?.string == "url", let url = node["url"]?.string, JS.test(url, "^https?:", options: .caseInsensitive) {
                out.append(["title": .string(clip(node["name"]?.string, 160)), "url": .string(url), "folder": .string(folder)])
            }
            let name = node["name"]?.string ?? ""
            let next = node["type"]?.string == "folder" && !name.isEmpty ? (folder.isEmpty ? name : "\(folder) / \(name)") : folder
            for child in node["children"]?.array ?? [] { visit(child, next) }
        }
        let names = ["bookmark_bar": "Bookmarks bar", "other": "Other bookmarks", "synced": "Mobile bookmarks"]
        for key in ["bookmark_bar", "other", "synced"] + (value["roots"]?.object?.keys.sorted().filter { !names.keys.contains($0) } ?? []) {
            if let root = value["roots"]?[key] { visit(root, names[key] ?? "") }
        }
        return out
    }

    /// The web links written in the notes under `dir`, most used first → [{ url, count, notes: [up to three note names] }].
    public static func linksIn(_ dir: String, limit: Int = 200, maxFiles: Int = 5000) -> [JSONValue] {
        var found: [String: (count: Int, notes: [String])] = [:]
        var order: [String] = []
        var files = 0
        walkFiles(resolve(dir), max: 200_000) { file, name in
            guard files < maxFiles, noteExt.contains(ext(name)) else { return }
            files += 1
            guard let text = try? String(contentsOfFile: file, encoding: .utf8) else { return }
            for m in JS.matches(text, #"https?://[^\s<>()\[\]"'`]+"#) {
                let url = JS.replace(m[0] ?? "", #"[.,;:!?*_]+$"#, "")
                if found[url] == nil { found[url] = (0, []); order.append(url) }
                found[url]!.count += 1
                let note = (name as NSString).deletingPathExtension
                if found[url]!.notes.count < 3 && !found[url]!.notes.contains(note) { found[url]!.notes.append(note) }
            }
        }
        return order.enumerated().sorted { found[$0.element]!.count != found[$1.element]!.count ? found[$0.element]!.count > found[$1.element]!.count : $0.offset < $1.offset }
            .prefix(limit).map { ["url": .string($0.element), "count": .number(Double(found[$0.element]!.count)), "notes": .array(found[$0.element]!.notes.map { .string($0) })] }
    }

    // MARK: Zotero

    /// zotero/mirror.cjs authorsOf.
    public static func authorsOf(_ item: JSONValue, max: Int = 3) -> String {
        let creators = item["creators"]?.array ?? []
        let authors = creators.filter { $0["type"]?.string == "author" }
        let names = (authors.isEmpty ? creators : authors).compactMap { c -> String? in
            let n = JS.truthy(c["last"]) ? JS.string(c["last"]) : JS.string(c["name"])
            return n.isEmpty ? nil : n
        }
        if names.isEmpty { return "" }
        if names.count > max { return "\(names[0]) et al." }
        return names.count == 1 ? names[0] : "\(names.dropLast().joined(separator: ", ")) and \(names.last!)"
    }

    /// The mirrored library's collections with how many items each holds.
    public static func zoteroCollections(_ root: String) throws -> (items: Int, unfiled: Int, collections: [(key: String, path: String, items: Int)]) {
        guard let items = readJSON(join(root, "items.json"))?.array else { throw ConnectError("failed", "Your Zotero library has not finished its first sync") }
        let collections = readJSON(join(root, "collections.json"))?.array ?? []
        var counts: [String: Int] = [:]
        var unfiled = 0
        for item in items {
            let keys = (item["collections"]?.array ?? []).map { JS.string($0) }
            if keys.isEmpty { unfiled += 1 }
            for key in keys { counts[key, default: 0] += 1 }
        }
        return (items.count, unfiled, collections.map { c in
            let key = JS.string(c["key"])
            return (key, JS.truthy(c["path"]) ? JS.string(c["path"]) : JS.string(c["name"]), counts[key] ?? 0)
        })
    }

    /// The mirrored library's items: in `collection` (with `nested`, its subcollections too), matching `query`.
    public static func zoteroItems(_ root: String, collection: String = "", nested: Bool = true, query: String = "", limit: Int = 500) throws -> [JSONValue] {
        guard let items = readJSON(join(root, "items.json"))?.array else { throw ConnectError("failed", "Your Zotero library has not finished its first sync") }
        let collections = readJSON(join(root, "collections.json"))?.array ?? []
        var byKey: [String: JSONValue] = [:]
        for c in collections { byKey[JS.string(c["key"])] = c }
        var wanted = Set(collection.isEmpty ? [] : [collection])
        if !collection.isEmpty && nested {
            var grew = true
            while grew {
                grew = false
                for c in collections where JS.truthy(c["parent"]) && wanted.contains(JS.string(c["parent"])) && !wanted.contains(JS.string(c["key"])) {
                    wanted.insert(JS.string(c["key"])); grew = true
                }
            }
        }
        let words = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        var out: [JSONValue] = []
        for item in items {
            let keys = (item["collections"]?.array ?? []).map { JS.string($0) }
            if !collection.isEmpty && !keys.contains(where: { wanted.contains($0) }) { continue }
            let authors = authorsOf(item)
            if !words.isEmpty {
                let tags = (item["tags"]?.array ?? []).map { JS.string($0) }.joined(separator: " ")
                let hay = "\(JS.string(item["title"])) \(authors) \(item["year"].map { $0.isNull ? "undefined" : JS.string($0) } ?? "undefined") \(tags)".lowercased()
                if !words.allSatisfy({ hay.contains($0) }) { continue }
            }
            let attachment = (item["attachments"]?.array ?? []).first { $0["contentType"]?.string == "application/pdf" && $0["linkMode"]?.string != "linked_url" }
            out.append(["key": .string(JS.string(item["key"])), "title": .string(clip(JS.string(item["title"]), 200)), "authors": .string(authors),
                        "year": .string(JS.truthy(item["year"]) ? JS.string(item["year"]) : ""), "doi": .string(JS.string(item["doi"])), "url": .string(JS.string(item["url"])),
                        "attachment": .string(attachment != nil ? "pdf" : ""), "collections": .array(keys.map { k in .string(byKey[k].flatMap { JS.truthy($0["path"]) ? JS.string($0["path"]) : nil } ?? k) })])
            if out.count >= limit { break }
        }
        return out
    }

    // MARK: PDFs on this Mac

    // Folders a Mac keeps documents in, looked through when the person let the agents read their home folder. ~/Zotero is
    // not among them: its PDFs come in through Zotero, with their metadata.
    static let pdfRootNames = ["Downloads", "Documents", "Desktop", "Papers", "Research", "Dropbox", "Library/Mobile Documents/com~apple~CloudDocs"]
    static let packageRE = #"\.(?:app|bundle|framework|photoslibrary|musiclibrary|tvlibrary|xcodeproj|xcworkspace|pkg|plugin|kext|lproj)$"#
    static let pdfSkip: Set<String> = ["Zotero", "Library", "site-packages", "dist", "build", "target", "vendor", "Pods"]

    /// The folders PDFs are looked for in: those of pdfRootNames that are here, and Google Drive's (and Dropbox's,
    /// OneDrive's) when it syncs to this Mac. `readable` (MATH-110): only those it lets through.
    public static func pdfRoots(_ homeDir: String = NSHomeDirectory(), readable: ((String) -> Bool)? = nil) -> [String] {
        let cloud = join(homeDir, "Library/CloudStorage")
        let drives = ((try? FileManager.default.contentsOfDirectory(atPath: cloud)) ?? []).sorted().filter { JS.test($0, "^(?:GoogleDrive|Dropbox|OneDrive)") }.map { join(cloud, $0) }
        return (pdfRootNames.map { join(homeDir, $0) } + drives).filter { readable?($0) ?? true }.filter(isDir)
    }

    /// Every PDF under `dir`, depth first to `depth` levels, packages and code folders passed over.
    @discardableResult
    static func walkPdfs(_ dir: String, max: Int = 40000, depth: Int = 6, readable: ((String) -> Bool)? = nil, _ visit: (String, String) -> Void) -> Bool {
        if let readable, !readable(dir) { return false }
        var seen = 0
        var stack: [(String, Int)] = [(dir, 0)]
        while let (here, level) = stack.popLast() {
            guard let list = entries(here) else { continue }
            for entry in list {
                seen += 1
                if seen > max { return true }
                if entry.name.hasPrefix(".") { continue }
                let full = join(here, entry.name)
                if entry.isDir {
                    if level < depth && !skipDirs.contains(entry.name) && !pdfSkip.contains(entry.name) && !JS.test(entry.name, packageRE, options: .caseInsensitive) && (readable?(full) ?? true) { stack.append((full, level + 1)) }
                } else if entry.isFile && JS.test(entry.name, #"\.pdf$"#, options: .caseInsensitive) { visit(full, entry.name) }
            }
        }
        return false
    }

    /// A PDF's title as the file says it, read cheaply from its first and last 64 KB (the XMP packet's dc:title, else the
    /// Info dictionary's /Title), or ''. A hint for the librarian, not a fact.
    public static func pdfTitle(_ file: String) -> String {
        guard let handle = FileHandle(forReadingAtPath: file) else { return "" }
        defer { try? handle.close() }
        guard let size = (try? handle.seekToEnd()).map(Int.init) else { return "" }
        let span = Swift.min(size, 64 * 1024)
        try? handle.seek(toOffset: 0)
        let head = (try? handle.read(upToCount: span)) ?? Data()
        try? handle.seek(toOffset: UInt64(Swift.max(0, size - span)))
        let tail = (try? handle.read(upToCount: span)) ?? Data()
        let text = (String(data: head, encoding: .isoLatin1) ?? "") + (String(data: tail, encoding: .isoLatin1) ?? "")
        if let xmp = JS.match(text, #"<dc:title>[\s\S]{0,200}?<rdf:li[^>]*>([^<]{3,300})</rdf:li>"#)?[1] ?? nil {
            let utf8 = String(decoding: xmp.data(using: .isoLatin1) ?? Data(), as: UTF8.self)
            return clip(utf8.replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">"), 200)
        }
        if let hex = JS.match(text, #"/Title\s*<(FEFF[0-9A-Fa-f]{4,600})>"#)?[1] ?? nil {
            var bytes: [UInt8] = []
            var chars = Array(hex.dropFirst(4))
            if chars.count % 2 == 1 { chars.removeLast() }
            var i = 0
            while i + 1 < chars.count { if let b = UInt8(String(chars[i...i + 1]), radix: 16) { bytes.append(b) }; i += 2 }
            var units: [UInt16] = []
            var j = 0
            while j + 1 < bytes.count { units.append(UInt16(bytes[j]) << 8 | UInt16(bytes[j + 1])); j += 2 }
            return clip(String(decoding: units, as: UTF16.self), 200)
        }
        guard let plain = JS.match(text, #"/Title\s*\(((?:\\.|[^\\)]){3,300})\)"#)?[1] ?? nil, !plain.hasPrefix("\u{fe}\u{ff}") else { return "" }
        let title = AppleNotes.sub(plain, #"\\([nrt()\\])"#, options: []) { g in ["n": " ", "r": " ", "t": " "][g[1]] ?? g[1] }
        if JS.test(title, #"[\x00-\x08]"#) || JS.test(title, #"^(?:untitled|microsoft word - .*|\s*)$"#, options: .caseInsensitive) { return "" }
        return clip(title, 200)
    }

    // What kind of PDF a name (and title) suggests: `paper`, `personal` (never offered), `book`, else `unclear`.
    static let paperIdRE = #"(?:^|[^\d])\d{4}\.\d{4,5}(?:v\d+)?(?:[^\d]|$)|^\d{5,}\.\d{5,}|^10\.\d{4,}"#
    static let personalRE = #"\b(?:invoice|receipt|bank statement|statement of account|bill|tax(?:es)?|w-?2|w-?9|1099|1040|payslip|pay ?stub|lease|rental agreement|insurance|boarding pass|ticket|itinerary|reservation|booking|confirmation|bank|passport|visa|i-?20|ds-?160|medical|prescription|lab results|vaccin\w*|resume|résumé|cover letter|offer letter|transcript|diploma|refund|warranty|utility)\b"#
    static let paperRE = #"\b(?:et al|arxiv|preprint|proceedings|proc\.|journal|conference|symposium|workshop|chi|uist|cscw|neurips|nips|icml|iclr|acl|emnlp|naacl|cvpr|iccv|eccv|sigcse|icer|aaai|ijcai|kdd|paper|thesis|dissertation)\b|^[a-z]+(?:[-_ ][a-z]+)?[-_ ]?(?:19|20)\d{2}[a-z]?(?:[-_ ]|\.pdf$)"#
    static let bookRE = #"\b(?:book|textbook|handbook|chapter|ch\d+|slides?|lecture|lec\d*|syllabus|manual|guide|notes|homework|hw\d*|problem set|pset|exam|midterm|final)\b"#

    public static func pdfGuess(_ name: String, _ title: String = "") -> String {
        let text = "\(JS.replace(JS.replace(name, #"\.pdf$"#, "", options: .caseInsensitive), "[_]+", " ")) \(title)"
        if JS.test(name, paperIdRE) { return "paper" }
        if JS.test(text, personalRE, options: .caseInsensitive) { return "personal" }
        if JS.test(name, paperRE, options: .caseInsensitive) || JS.test(title, paperRE, options: .caseInsensitive) { return "paper" }
        if JS.test(text, bookRE, options: .caseInsensitive) { return "book" }
        return "unclear"
    }

    // Words too common to say a PDF is about a project.
    static let commonWords: Set<String> = Set(("the and for are but not you all can our its how why who use new one two any via per out own way "
        + "this that with from what which their about into will would could should have been being were they them these those there "
        + "where when while more most also such than then some only other over under each using used based study studying studies "
        + "research project projects paper papers work works done look looks like make makes help helps does want need between "
        + "through across toward towards your mine them want what whether among within without many much very well just even still "
        + "first second third done goal goals aim aims learn more less part parts thing things time year years final draft notes").split(separator: " ").map(String.init))

    /// A text's words for matching: lower case, letters and digits, the common ones left out.
    public static func wordsOf(_ text: String) -> [String] {
        let lower = JS.replace(text.lowercased(), #"\.pdf$"#, "")
        return lower.components(separatedBy: CharacterSet.letters.union(.decimalDigits).inverted)
            .filter { $0.count >= 3 && !commonWords.contains($0) && !JS.test($0, #"^\d+$"#) }
    }

    /// How many of a project's words a PDF's name and title share ("debug" and "debugging" count: five or more letters).
    public static func sharedWords(_ projectWords: [String], _ text: String) -> Int {
        let here = wordsOf(text)
        return projectWords.filter { word in here.contains { $0 == word || (Swift.min(word.count, $0.count) >= 5 && ($0.hasPrefix(word) || word.hasPrefix($0))) } }.count
    }

    /// The folders under `roots` that hold PDFs, most first (readers.cjs pdfFolders: project matching, the period, the
    /// older related ones).
    public static func pdfFolders(_ roots: [String], homeDir: String = NSHomeDirectory(), top: Int = 40, samples: Int = 6, titles: Int = 150, max: Int = 40000,
                                  project: (name: String, description: String)? = nil, related: Int = 10, matchTitles: Int = 300, days: Double? = nil,
                                  olderRelatedMax: Int = 5, readable: ((String) -> Bool)? = nil) -> JSONValue {
        final class PDF { let file: String; let name: String; let mtime: Double; var shared = 0
            init(_ f: String, _ n: String, _ m: Double) { file = f; name = n; mtime = m } }
        final class Folder { let path: String; var files: [PDF] = []; var olderLeftOut = 0; var pdfs = 0; var newest = 0.0; var related = 0
            init(_ p: String) { path = p } }
        var byFolder: [String: Folder] = [:]
        var order: [String] = []
        var truncated = false
        // A folder inside another one looked through is not looked through twice.
        var unique: [String] = []
        for r in roots.map(resolve) where !unique.contains(r) { unique.append(r) }
        let sorted = unique.enumerated().sorted { $0.element.count != $1.element.count ? $0.element.count < $1.element.count : $0.offset < $1.offset }.map(\.element)
        let seenRoots = sorted.enumerated().filter { i, dir in !sorted.prefix(i).contains { dir.hasPrefix($0 + "/") } }.map(\.element)
        for dir in seenRoots {
            let cut = walkPdfs(dir, max: max, readable: readable) { file, name in
                let folder = dirname(file)
                if byFolder[folder] == nil { byFolder[folder] = Folder(folder); order.append(folder) }
                byFolder[folder]!.files.append(PDF(file, name, statOf(file)?.mtimeMs ?? 0))
            }
            truncated = cut || truncated
        }
        var budget = titles
        var titleOf: [String: String] = [:]
        func readTitle(_ file: String) -> String { if let t = titleOf[file] { return t }; let t = pdfTitle(file); titleOf[file] = t; return t }
        var projectWords: [String] = []
        if let project { for w in wordsOf("\(project.name) \(project.description)") where !projectWords.contains(w) { projectWords.append(w) } }
        let folders = order.compactMap { byFolder[$0] }
        if !projectWords.isEmpty {
            let every = folders.flatMap(\.files).filter { pdfGuess($0.name) != "personal" }
            every.enumerated().sorted { $0.element.mtime != $1.element.mtime ? $0.element.mtime > $1.element.mtime : $0.offset < $1.offset }.prefix(matchTitles).forEach { _ = readTitle($0.element.file) }
            for f in folders { for each in f.files {
                let title = titleOf[each.file] ?? ""
                each.shared = pdfGuess(each.name, title) == "personal" ? 0 : sharedWords(projectWords, "\(each.name) \(title)")
            } }
        }
        let since = cutoff(days)
        var older: [PDF] = []
        for f in folders {
            let inPeriod = since > 0 ? f.files.filter { $0.mtime >= since } : f.files
            if since > 0 { older.append(contentsOf: f.files.filter { $0.mtime < since }) }
            f.olderLeftOut = f.files.count - inPeriod.count
            f.files = inPeriod
            f.pdfs = inPeriod.count
            f.newest = Swift.max(0, inPeriod.map(\.mtime).max() ?? 0)
            f.related = inPeriod.filter { $0.shared > 0 }.count
        }
        let total = folders.reduce(0) { $0 + $1.pdfs }
        let list = folders.enumerated().filter { $0.element.pdfs > 0 }.sorted { a, b in
            if !projectWords.isEmpty && (a.element.related > 0) != (b.element.related > 0) { return a.element.related > 0 }
            if a.element.pdfs != b.element.pdfs { return a.element.pdfs > b.element.pdfs }
            if a.element.newest != b.element.newest { return a.element.newest > b.element.newest }
            return a.offset < b.offset
        }.map(\.element)
        func shown(_ each: PDF) -> String {
            var title = ""
            if titleOf[each.file] != nil { title = readTitle(each.file) } else if budget > 0 { budget -= 1; title = readTitle(each.file) } else { budget -= 1 }
            return !title.isEmpty && title != JS.replace(each.name, #"\.pdf$"#, "", options: .caseInsensitive) ? "\(each.name) — \(title)" : each.name
        }
        let folderJSON: [JSONValue] = list.prefix(top).map { f in
            var kinds: [String: Int] = ["paper": 0, "personal": 0, "book": 0, "unclear": 0]
            for each in f.files { kinds[pdfGuess(each.name), default: 0] += 1 }
            let byNewest = f.files.enumerated().sorted { $0.element.mtime != $1.element.mtime ? $0.element.mtime > $1.element.mtime : $0.offset < $1.offset }.map(\.element).filter { pdfGuess($0.name) != "personal" }
            let matched = projectWords.isEmpty ? [] : Array(byNewest.filter { $0.shared > 0 }.enumerated().sorted { a, b in
                a.element.shared != b.element.shared ? a.element.shared > b.element.shared : (a.element.mtime != b.element.mtime ? a.element.mtime > b.element.mtime : a.offset < b.offset)
            }.map(\.element).prefix(related))
            let newest = byNewest.filter { e in !matched.contains { $0 === e } }.prefix(samples)
            let examples = (matched + newest).map(shown)
            var o: [String: JSONValue] = ["folder": .string(shownPath(homeDir, f.path)), "path": .string(f.path), "pdfs": .number(Double(f.pdfs)),
                                         "newest": iso(f.newest).map { .string($0) } ?? .null,
                                         "kinds": .object(kinds.filter { $0.value > 0 }.mapValues { .number(Double($0)) }), "examples": .array(examples.map { .string($0) })]
            if !projectWords.isEmpty { o["relatedToProject"] = .number(Double(f.related)) }
            if since > 0 { o["olderLeftOut"] = .number(Double(f.olderLeftOut)) }
            return .object(o)
        }
        var out: [String: JSONValue] = ["roots": .array(seenRoots.map { .string(shownPath(homeDir, $0)) }), "pdfs": .number(Double(total)), "folders": .array(folderJSON),
                                        "moreFolders": .number(Double(Swift.max(0, list.count - top))), "truncated": .bool(truncated)]
        if since == 0 { return .object(out) }
        let olderRelated = older.enumerated().filter { $0.element.shared > 0 && pdfGuess($0.element.name, titleOf[$0.element.file] ?? "") != "personal" }
            .sorted { a, b in a.element.shared != b.element.shared ? a.element.shared > b.element.shared : (a.element.mtime != b.element.mtime ? a.element.mtime > b.element.mtime : a.offset < b.offset) }
            .prefix(olderRelatedMax).map { e -> JSONValue in
                let t = readTitle(e.element.file)
                return ["name": .string(e.element.name), "title": t.isEmpty ? .null : .string(t), "path": .string(e.element.file), "changed": iso(e.element.mtime).map { .string($0) } ?? .null]
            }
        out["olderLeftOut"] = .number(Double(older.count))
        out["olderRelated"] = .array(olderRelated)
        return .object(out)
    }

    /// The PDFs under `dir`, newest first, with the kind its name suggests.
    public static func pdfFiles(_ dir: String, days: Double? = nil, query: String = "", kind: String = "", include: [String] = [], exclude: [String] = [],
                                limit: Int = 300, titles: Bool = true, readable: ((String) -> Bool)? = nil) -> (total: Int, pdfs: [JSONValue]) {
        let root = resolve(dir)
        let ins = norm(include), outs = norm(exclude)
        let since = cutoff(days)
        var found: [(file: String, name: String, folder: String, mtime: Double, size: Int)] = []
        walkPdfs(root, max: 200_000, depth: 12, readable: readable) { file, name in
            let rel = relative(root, dirname(file))
            if !ins.isEmpty && !ins.contains(where: { under(rel, $0) }) { return }
            if outs.contains(where: { under(rel, $0) }) { return }
            guard let st = statOf(file), !(since > 0 && st.mtimeMs < since) else { return }
            found.append((file, name, rel, st.mtimeMs, st.size))
        }
        let words = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        var out: [JSONValue] = []
        for entry in found.enumerated().sorted(by: { $0.element.mtime != $1.element.mtime ? $0.element.mtime > $1.element.mtime : $0.offset < $1.offset }).map(\.element) {
            if out.count >= limit { break }
            let title = titles ? pdfTitle(entry.file) : ""
            let guess = pdfGuess(entry.name, title)
            if !kind.isEmpty && guess != kind { continue }
            if !words.isEmpty { let text = "\(entry.name) \(title) \(entry.folder)".lowercased(); if !words.allSatisfy({ text.contains($0) }) { continue } }
            out.append(["path": .string(entry.file), "name": .string(entry.name), "title": title.isEmpty ? .null : .string(title), "folder": .string(entry.folder.isEmpty ? "." : entry.folder),
                        "modified": iso(entry.mtime).map { .string($0) } ?? .null, "size": .number(Double(entry.size)), "kind": .string(guess)])
        }
        return (found.count, out)
    }
}
