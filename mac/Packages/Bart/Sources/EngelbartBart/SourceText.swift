import Foundation
import EngelbartDoc
import CryptoKit
import EngelbartCore

// shots.cjs — the pictures of the web page in front that @bart turns are given (MATH-54 build 3a): one PNG per turn,
// <dataRoot>/bart-shots/<turn id>.png, inside the data folder the agent's file tools may already read. Bart is given the
// path alone (<screenshot path="…"/>) and opens it only when the answer depends on how the page looks. The last 20 are
// kept; each new one deletes those older than that.
public enum Shots {
    public static let dir = "bart-shots"
    public static let maxShots = 20

    public static func shotsDir(_ dataRoot: String) -> String { (dataRoot as NSString).appendingPathComponent(dir) }

    /// Deletes all but the newest `keep` pictures in `dir` (by when each was written; `newest` among them whatever its
    /// time says); nothing else is touched. → the names deleted.
    @discardableResult
    public static func prune(_ dir: String, keep: Int = maxShots, newest: String = "") -> [String] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [] }
        var dated: [(name: String, at: Double)] = []
        for name in names where name.hasSuffix(".png") {
            if let attrs = try? FileManager.default.attributesOfItem(atPath: (dir as NSString).appendingPathComponent(name)), let d = attrs[.modificationDate] as? Date {
                dated.append((name, d.timeIntervalSince1970))
            }
        }
        dated.sort { a, b in
            if (a.name == newest) != (b.name == newest) { return a.name == newest }
            if a.at != b.at { return a.at > b.at }
            return jsLess(b.name, a.name)
        }
        var gone: [String] = []
        for (name, _) in dated.dropFirst(max(0, keep)) {
            if (try? FileManager.default.removeItem(atPath: (dir as NSString).appendingPathComponent(name))) != nil { gone.append(name) }
        }
        return gone
    }

    /// `png` kept as turn `id`'s picture, then the older ones pruned. → its absolute path, or nil.
    public static func save(_ dataRoot: String, id: String, png: Data?, keep: Int = maxShots) -> String? {
        guard let png, !png.isEmpty, JSRegex("^[A-Za-z0-9_-]{1,64}$").test(id) else { return nil }
        let dir = shotsDir(dataRoot), file = (dir as NSString).appendingPathComponent("\(id).png")
        do {
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try png.write(to: URL(fileURLWithPath: file))
            chmod(file, 0o600)
        } catch { return nil }
        prune(dir, keep: keep, newest: "\(id).png")
        return file
    }
}

// connect/gmail.cjs htmlText: an html page's readable text (links as markdown, blocks as lines).
public enum HTMLText {
    static func decode(_ s: String) -> String {
        var out = s
        for (k, v) in [("&nbsp;", "\u{00A0}"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'")] { out = out.replacingOccurrences(of: k, with: v) }
        out = JSRegex("&#(\\d+);", "g").replace(out) { m in Int(m[1]!).flatMap { Unicode.Scalar($0) }.map { String(Character($0)) } ?? m.whole }
        out = JSRegex("&#x([0-9a-f]+);", "gi").replace(out) { m in Int(m[1]!, radix: 16).flatMap { Unicode.Scalar($0) }.map { String(Character($0)) } ?? m.whole }
        return out.replacingOccurrences(of: "&amp;", with: "&")
    }

    public static func text(_ html: String?) -> String {
        var v = html ?? ""
        v = JSRegex("<!--[\\s\\S]*?-->", "g").replace(v, with: "")
        v = JSRegex("<(script|style|head|title)\\b[\\s\\S]*?</\\1>", "gi").replace(v, with: "")
        v = JSRegex("<a\\b[^>]*\\bhref\\s*=\\s*\"(https?://[^\"]+)\"[^>]*>([\\s\\S]*?)</a>", "gi").replace(v) { m in
            let label = decode(JSRegex("<[^>]+>", "g").replace(m[2] ?? "", with: "")).squashedSpaces
            let url = decode(m[1] ?? "")
            return label.isEmpty || label == url ? url : "[\(label)](\(url))"
        }
        v = JSRegex("<br\\s*/?>", "gi").replace(v, with: "\n")
        v = JSRegex("<li\\b[^>]*>", "gi").replace(v, with: "\n- ")
        v = JSRegex("</(p|div|tr|li|h[1-6]|table|blockquote|ul|ol)>", "gi").replace(v, with: "\n")
        v = JSRegex("<(p|div|tr|table|blockquote|hr|h[1-6])\\b[^>]*>", "gi").replace(v, with: "\n")
        v = JSRegex("</t[dh]>", "gi").replace(v, with: " ")
        v = JSRegex("<[^>]+>", "g").replace(v, with: "")
        v = JSRegex("\\r\\n?", "g").replace(decode(v), with: "\n")
        let lines = v.components(separatedBy: "\n").map { JSRegex("[ \\t\\u00a0]+", "g").replace($0, with: " ").jsTrim }.joined(separator: "\n")
        return JSRegex("\\n{3,}", "g").replace(lines, with: "\n\n").jsTrim
    }
}

// source-text.cjs — what Chat reads of a source it cannot open as it is (2026-10-22). A PDF: its text, as the sweep keeps
// it for search, written to <data root>/assets/text/<id>-<mtime>.txt and named in Context.json as the item's `text`. A
// page in the library by its address alone: its text once Chat has read it (keepPageTexts). And what Chat read while it
// answered (openedBy), which a citation of a whole source must be among. An item's highlights and the person's notes on
// them (noteTexts, 2026-10-23): <data root>/assets/notes/<id>-<mtime>.txt, named as the item's `notes`.
public enum SourceText {
    public static let maxTextChars = 4_000_000
    static let pageTimeout: TimeInterval = 8
    static let maxPageBytes = 4 * 1024 * 1024

    public static func textDir(_ dataRoot: String) -> String { ((dataRoot as NSString).appendingPathComponent("assets") as NSString).appendingPathComponent("text") }
    public static func notesDir(_ dataRoot: String) -> String { ((dataRoot as NSString).appendingPathComponent("assets") as NSString).appendingPathComponent("notes") }

    /// Whether a library row is read from its kept text: a pdf on disk, or a page known by its address alone.
    public static func keepsText(_ row: LibraryRow) -> Bool {
        (row.type == "pdf" && !(row.path ?? "").isEmpty) || (row.type == "website" && (row.path ?? "").isEmpty && !(row.url ?? "").isEmpty)
    }

    /// How what was read is matched with what is cited: a web address as AddressKey spells it, a path resolved.
    public static func openedKey(_ where_: String?) -> String {
        let w = where_ ?? ""
        if JSRegex("^https?://", "i").test(w) { return "url:\(AddressKey.addressKey(w))" }
        return "file:\(resolve(w))"
    }

    static func resolve(_ p: String) -> String {
        let abs = p.hasPrefix("/") ? p : (FileManager.default.currentDirectoryPath as NSString).appendingPathComponent(p)
        return (abs as NSString).standardizingPath
    }

    static func listDir(_ dir: String) -> Set<String> { Set((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []) }

    /// The text files of `rows` that have kept text → row id → absolute path. Written when the text is newer than the one
    /// there (its name carries the time it was read at); older ones of the row go. Best effort.
    public static func sourceTexts(dataRoot: String, db: BartLibraryDB, rows: [LibraryRow]) async -> [String: String] {
        var out: [String: String] = [:]
        guard !dataRoot.isEmpty, let stamps = try? await db.textStamps() else { return out }
        let dir = textDir(dataRoot)
        let wanted = rows.filter { keepsText($0) && stamps[$0.id] != nil }
        if wanted.isEmpty { return out }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let present = listDir(dir)
        func fileOf(_ row: LibraryRow) -> String { "\(row.id)-\(Int(jsRound(stamps[row.id] ?? 0))).txt" }
        let missing = wanted.filter { !present.contains(fileOf($0)) }
        let texts = missing.isEmpty ? [:] : ((try? await db.texts(for: missing.map { $0.id }, max: maxTextChars)) ?? [:])
        for row in wanted {
            let name = fileOf(row)
            if !present.contains(name) {
                guard let text = texts[row.id], !text.isEmpty else { continue } // nothing in it
                let path = (dir as NSString).appendingPathComponent(name)
                guard (try? writePrivate(path, text)) != nil else { continue }
                for old in present where old.hasPrefix("\(row.id)-") && old != name { removeFile((dir as NSString).appendingPathComponent(old)) }
            }
            out[row.id] = (dir as NSString).appendingPathComponent(name)
        }
        return out
    }

    /// An item's ink as its notes file holds it: a <paper> (or a web <page>) with each highlight as <highlights> shows one;
    /// '' when it has none.
    public static func inkText(_ row: LibraryRow, _ ink: JSONValue?, inkRoot: String = "") -> String {
        let list = Highlights.marksOf(ink, inkRoot: inkRoot) + Highlights.webMarksOf(ink, inkRoot: inkRoot)
        if list.isEmpty { return "" }
        let paper = row.type == "pdf" || (row.url ?? "").isEmpty
        let head = paper ? "<paper name=\"\(Highlights.attrOf(row.name, 200))\" path=\"\(Highlights.attrOf(row.path, 4096))\">"
            : "<page source=\"web\" title=\"\(Highlights.attrOf(row.name, 200))\" address=\"\(Highlights.attrOf(row.url, 4096))\"\((row.path ?? "").isEmpty ? "" : " path=\"\(Highlights.attrOf(row.path, 4096))\"")>"
        return "\(head)\n\(list.map(Highlights.highlightXml).joined())\(paper ? "</paper>" : "</page>")\n"
    }

    nonisolated(unsafe) static var hashes: [String: String] = [:]
    static let hashLock = NSLock()

    /// A file's contents as a hash, by its path, size and time: a pdf added twice is found once per change.
    static func contentHash(_ file: String) throws -> String {
        let attrs = try FileManager.default.attributesOfItem(atPath: file)
        let key = "\(file)\0\(attrs[.size] ?? 0)\0\((attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)"
        hashLock.lock(); if let h = hashes[key] { hashLock.unlock(); return h }; hashLock.unlock()
        let data = try Data(contentsOf: URL(fileURLWithPath: file))
        let h = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        hashLock.lock(); hashes[key] = h; hashLock.unlock()
        return h
    }

    /// Where each of `rows` has its ink → row id → (file, the row it was drawn on): its own, else, for a pdf, that of another
    /// row that is the same file at another path (a paper added twice, 2026-10-23).
    public static func inkFiles(store: BartStore, rows: [LibraryRow]) -> [String: (file: String, row: LibraryRow)] {
        var out: [String: (file: String, row: LibraryRow)] = [:]
        var pdfs: [LibraryRow] = []
        for row in rows {
            if let file = store.inkFile(of: row) { out[row.id] = (file, row) }
            if row.type == "pdf", !(row.path ?? "").isEmpty { pdfs.append(row) }
        }
        func sizeOf(_ row: LibraryRow) -> Int { ((try? FileManager.default.attributesOfItem(atPath: row.path ?? ""))?[.size] as? Int) ?? -1 }
        let inked = pdfs.filter { out[$0.id] != nil }.map { ($0, sizeOf($0)) }.filter { $0.1 > 0 }
        if inked.isEmpty { return out }
        for row in pdfs where out[row.id] == nil {
            let size = sizeOf(row)
            if size <= 0 { continue }
            if let twin = inked.first(where: { one in
                one.1 == size && resolve(one.0.path!) != resolve(row.path!) && ((try? contentHash(one.0.path!)) ?? "a") == ((try? contentHash(row.path!)) ?? "b")
            }) { out[row.id] = out[twin.0.id] }
        }
        return out
    }

    public static func readInk(_ files: [String: (file: String, row: LibraryRow)], _ row: LibraryRow) -> JSONValue? {
        guard let held = files[row.id], let data = FileManager.default.contents(atPath: held.file) else { return nil }
        return try? JSONValue.parse(data)
    }

    /// The notes files of `rows` that have ink → row id → absolute path, each naming the copy the highlights are on.
    public static func noteTexts(dataRoot: String, store: BartStore, rows: [LibraryRow]) -> [String: String] {
        var out: [String: String] = [:]
        guard !dataRoot.isEmpty else { return out }
        let dir = notesDir(dataRoot), inkRoot = (dataRoot as NSString).appendingPathComponent("annotations")
        let files = inkFiles(store: store, rows: rows)
        var present: Set<String>? = nil
        for row in rows {
            guard let held = files[row.id],
                  let attrs = try? FileManager.default.attributesOfItem(atPath: held.file), let m = attrs[.modificationDate] as? Date else { continue }
            let name = "\(row.id)-\(Int(jsRound(m.timeIntervalSince1970 * 1000))).txt"
            if present == nil {
                try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                present = listDir(dir)
            }
            if !present!.contains(name) {
                for old in present! where old.hasPrefix("\(row.id)-") { removeFile((dir as NSString).appendingPathComponent(old)); present!.remove(old) }
                guard let data = FileManager.default.contents(atPath: held.file), let ink = try? JSONValue.parse(data) else { continue }
                let text = inkText(held.row, ink, inkRoot: inkRoot)
                if text.isEmpty { continue } // ink with no highlight left
                guard (try? writePrivate((dir as NSString).appendingPathComponent(name), text)) != nil else { continue }
                present!.insert(name)
            }
            out[row.id] = (dir as NSString).appendingPathComponent(name)
        }
        return out
    }

    /// What one answer's raw events say Chat read → set of openedKey. Claude Code: Read's file, Grep's when it is a file,
    /// WebFetch's address. Codex: a command that names a file among `known` (as it is or with its spaces escaped). A kept
    /// text file counts as its source (`texts`: text path → source). `full`: what the context already held whole.
    public static func openedBy(_ events: [JSONValue], known: [String] = [], texts: [String: String] = [:], full: [String] = []) -> Set<String> {
        var out = Set(full.filter { !$0.isEmpty }.map(openedKey))
        func add(_ where_: String?) {
            guard let w = where_, !w.isEmpty else { return }
            let resolved = JSRegex("^https?://", "i").test(w) ? w : resolve(w)
            out.insert(openedKey(texts[resolved] ?? resolved))
        }
        for event in events {
            for call in ToolCalls.of(event) {
                guard let input = call.input, input.isObject else { continue }
                if call.name == "Read", let f = input["file_path"]?.string { add(f) }
                else if call.name == "Grep", let p = input["path"]?.string, JSRegex("\\.[A-Za-z0-9_]{1,8}$").test(p) { add(p) }
                else if call.name == "WebFetch", let u = input["url"]?.string { add(u) }
                else if call.name == "command", let command = input["command"]?.string {
                    for file in known + Array(texts.keys) where !file.isEmpty {
                        let escaped = JSRegex("([ '\"()&])", "g").replace(file) { "\\" + $0.whole }
                        if command.contains(file) || command.contains(escaped) { add(file) }
                    }
                }
            }
        }
        return out
    }

    /// A page's readable text, fetched without cookies; nil when it is not an html page or cannot be had.
    public static func fetchPageText(_ url: String, fetch: PageFetch = urlSessionPageFetch) async -> String? {
        guard JSRegex("^https?://", "i").test(url), let u = URL(string: url) else { return nil }
        guard let (status, type, data) = try? await fetch(u), (200...299).contains(status), JSRegex("html", "i").test(type) else { return nil }
        let html = String(decoding: data.prefix(maxPageBytes), as: UTF8.self)
        let text = HTMLText.text(html)
        return text.jsTrim.isEmpty ? nil : text
    }

    public typealias PageFetch = @Sendable (URL) async throws -> (status: Int, contentType: String, body: Data)
    public static let urlSessionPageFetch: PageFetch = { url in
        var request = URLRequest(url: url, timeoutInterval: pageTimeout)
        request.httpShouldHandleCookies = false
        request.setValue("text/html", forHTTPHeaderField: "accept")
        let session = URLSession(configuration: .ephemeral)
        let (data, response) = try await session.data(for: request)
        let http = response as? HTTPURLResponse
        return (http?.statusCode ?? 0, http?.value(forHTTPHeaderField: "content-type") ?? "", data)
    }

    /// Keeps the text of each page among `rows` known by its address alone that Chat read (`opened`) and that has none
    /// kept yet. → how many were kept.
    @discardableResult
    public static func keepPageTexts(db: BartLibraryDB, rows: [LibraryRow], opened: Set<String>?, fetch: @escaping PageFetch = urlSessionPageFetch) async -> Int {
        guard let opened, !opened.isEmpty else { return 0 }
        let pages = rows.filter { $0.type == "website" && ($0.path ?? "").isEmpty && !($0.url ?? "").isEmpty && opened.contains(openedKey($0.url)) }
        if pages.isEmpty { return 0 }
        let stamps = (try? await db.textStamps()) ?? [:]
        var kept = 0
        await withTaskGroup(of: Bool.self) { group in
            for row in pages where stamps[row.id] == nil {
                group.addTask {
                    guard let text = await fetchPageText(row.url!, fetch: fetch) else { return false }
                    return (try? await db.setText(row.id, text: text, modified: Time.ms())) != nil
                }
            }
            for await ok in group where ok { kept += 1 }
        }
        return kept
    }
}
