import Foundation
import EngelbartDoc
import EngelbartCore

// create.cjs — @create's files (2026-10-13). Each run writes in a draft folder of its own, <dataRoot>/.create/<askId>/,
// made empty before the run and the agent's working directory: the only place it may write. After a run that answered,
// the files it left are kept, at most five, each at most 20 MB and of a format the library reads; then the draft folder
// is deleted; a run stopped or failed deletes it and keeps nothing. 2026-10-14: kept files go to
// <project>/.created/<askId>/, so the answer's rows (one `@[name](made:<askId>/<path>)` line per file), its expanded
// view and the Stage still open them after a restart. Save puts one in the library (source `create`, the Assets chip),
// linked to the workspace; which file was saved as which row is kept beside the files (SAVED_FILE). 2026-10-15 (David's):
// each file is saved as its run ends (saveAllCreated), once.

/// What the Store does for @create's Save (store/library.cjs addMarkdownCopy, build/engelbart-tools.cjs keepCopy and
/// linkMade, libraryDb.setSource/get).
public protocol CreatedLibrary: AnyObject, Sendable {
    /// The project's own folder.
    func projectDir(projectId: String) throws -> String
    /// A library row by id while the library still holds it.
    func row(id: String) async -> LibraryRow?
    /// The file put in the library as a row of its own (Markdown a note of the library's own, a pdf or a picture a copy,
    /// anything else under assets/files), its source `create`, linked to `workspaceId` and announced. → the row.
    func saveCreated(projectId: String, workspaceId: String?, file: String, name: String, type: String) async throws -> LibraryRow
}

public struct CreatedFile: Equatable, Sendable { public var name: String, rel: String, type: String, size: Int }
public struct Kept: Equatable, Sendable { public var files: [CreatedFile]; public var skipped: [String] }

public enum Create {
    public static let createDir = ".create"
    public static let createdDir = ".created"
    public static let savedFile = ".engelbart-saved.json"
    public static let previewsDir = ".engelbart-previews"
    public static let maxCreated = 5
    public static let maxCreatedBytes = 20 * 1024 * 1024
    public static let timeout: TimeInterval = 10 * 60
    /// store/library.cjs FILE_TYPES: the formats the library keeps.
    public static let fileTypes: [String: String] = [".md": "md", ".markdown": "md", ".pdf": "pdf", ".html": "html", ".htm": "html", ".csv": "csv", ".tsv": "tsv",
                                                     ".json": "json", ".jsonl": "jsonl", ".ndjson": "jsonl", ".parquet": "parquet", ".xlsx": "xlsx", ".docx": "docx",
                                                     ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".heic": "image", ".svg": "image"]
    static let idRE = JSRegex("^[A-Za-z0-9_-]+$")

    public struct InvalidID: Error, LocalizedError { public var errorDescription: String? { "ask id is invalid" } }
    public struct InvalidFile: Error, LocalizedError { public var errorDescription: String? { "file is invalid" } }
    public struct Refused: Error, LocalizedError { public let message: String; public var errorDescription: String? { message } }

    static func ext(_ file: String) -> String { let e = (file as NSString).pathExtension; return e.isEmpty ? "" : ".\(e.lowercased())" }

    /// Where an ask's draft folder is.
    public static func draftPath(_ dataRoot: String, _ askId: String) throws -> String {
        guard idRE.test(askId) else { throw InvalidID() }
        return ((dataRoot as NSString).appendingPathComponent(createDir) as NSString).appendingPathComponent(askId)
    }

    /// The ask's draft folder, made empty → its real path, as the agent's tools see it.
    public static func openDraft(_ dataRoot: String, _ askId: String) throws -> String {
        let dir = try draftPath(dataRoot, askId)
        try? FileManager.default.removeItem(atPath: dir)
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return URL(fileURLWithPath: dir).resolvingSymlinksInPath().path
    }

    public static func dropDraft(_ dir: String?) { if let dir { try? FileManager.default.removeItem(atPath: dir) } }

    /// The files the run left: plain files only, in the folder and any under it; a link is not followed and is skipped.
    public static func draftFiles(_ dir: String) -> (found: [(file: String, rel: String, size: Int)], odd: [(rel: String, why: String)]) {
        var found: [(String, String, Int)] = [], odd: [(String, String)] = []
        func walk(_ at: String) {
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: at) else { return }
            for name in names.sorted(by: jsLess) {
                let file = (at as NSString).appendingPathComponent(name)
                let rel = String(file.dropFirst(dir.count + 1))
                var st = stat()
                guard lstat(file, &st) == 0 else { continue }
                switch st.st_mode & S_IFMT {
                case S_IFDIR: walk(file)
                case S_IFREG: found.append((file, rel, Int(st.st_size)))
                default: odd.append((rel, "not a plain file"))
                }
            }
        }
        walk(dir)
        return (found, odd)
    }

    /// A file's name as its row is named: without its extension.
    public static func rowName(_ file: String) -> String {
        let base = ((file as NSString).lastPathComponent as NSString).deletingPathExtension.jsTrim
        return base.isEmpty ? "Untitled" : base
    }

    /// A path inside the created folder as a row's token carries it (doc.js encodeRel): each segment encoded, !'()* too.
    public static func encodeRel(_ rel: String?) -> String {
        (rel ?? "").components(separatedBy: "/").filter { !$0.isEmpty && $0 != "." }.map { part in
            JSRegex("[!'()*]", "g").replace(encodeURIComponent(part)) { m in String(format: "%%%02X", m.whole.utf16.first!) }
        }.joined(separator: "/")
    }

    public static func createdDir(_ projectDir: String, _ askId: String) throws -> String {
        guard idRE.test(askId) else { throw InvalidID() }
        return ((projectDir as NSString).appendingPathComponent(createdDir) as NSString).appendingPathComponent(askId)
    }

    /// One kept file by its path in the run's folder: never outside it, never the saved list or the previews.
    public static func createdFile(_ projectDir: String, _ askId: String, _ rel: String?) throws -> String {
        let dir = try createdDir(projectDir, askId)
        let r = rel ?? ""
        let parts = r.components(separatedBy: "/").filter { !$0.isEmpty }
        if parts.isEmpty || JSRegex("^[/\\\\]").test(r) || parts.contains(where: { $0 == "." || $0 == ".." || $0.contains("\0") }) || parts[0] == savedFile || parts[0] == previewsDir { throw InvalidFile() }
        let file = parts.reduce(dir) { ($0 as NSString).appendingPathComponent($1) }
        guard file.hasPrefix(dir + "/") else { throw InvalidFile() }
        return file
    }

    static func readSaved(_ dir: String) -> [String: String] {
        var out: [String: String] = [:]
        for (k, v) in savedPairs(dir) { if let s = v.string { out[k] = s } }
        return out
    }
    /// The saved list as the file holds it, in its order (a new file's entry goes last, as `saved[rel] = id` does).
    static func savedPairs(_ dir: String) -> [(String, OJ)] {
        OJ.read(URL(fileURLWithPath: (dir as NSString).appendingPathComponent(savedFile)))?.pairs ?? []
    }

    /// The draft folder's files kept in <project>/.created/<askId>/, under the paths they were written at.
    public static func keepCreated(projectDir: String, askId: String, draft: String) throws -> Kept {
        let (found, odd) = draftFiles(draft)
        var files: [CreatedFile] = []
        var skipped = odd.map { "\($0.rel): \($0.why)" }
        let into = try createdDir(projectDir, askId)
        for (file, rel, size) in found {
            let e = ext(file)
            guard let type = fileTypes[e] else { skipped.append("\(rel): \(e.isEmpty ? "no extension" : e) is not a format the library keeps"); continue }
            if size > maxCreatedBytes { skipped.append("\(rel): larger than 20 MB"); continue }
            if files.count >= maxCreated { skipped.append("\(rel): past the \(maxCreated) files Create keeps"); continue }
            do {
                let to = (into as NSString).appendingPathComponent(rel)
                try FileManager.default.createDirectory(atPath: (to as NSString).deletingLastPathComponent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                try? FileManager.default.removeItem(atPath: to)
                try Files.cloneItem(at: URL(fileURLWithPath: file), to: URL(fileURLWithPath: to))
                files.append(CreatedFile(name: (file as NSString).lastPathComponent, rel: rel, type: type, size: size))
            } catch {
                skipped.append("\(rel): \(String(error.localizedDescription.components(separatedBy: "\n")[0].prefix(160)))")
            }
        }
        return Kept(files: files, skipped: skipped)
    }

    /// The line of the answer that stands for one kept file: the editor draws it as Create's row.
    public static func madeMention(_ askId: String, _ file: CreatedFile) -> String {
        let name = JSRegex("[\\[\\]\\n]", "g").replace(file.name, with: "").jsTrim
        return "@[\(name.isEmpty ? "Untitled" : name)](made:\(askId)/\(encodeRel(file.rel)))"
    }

    /// The answer as the document keeps it: the sentence, one line per file kept, then what was skipped.
    public static func createdBody(_ text: String?, _ kept: Kept, _ askId: String) -> String {
        [(text ?? "").jsTrim,
         kept.files.isEmpty ? "" : kept.files.map { madeMention(askId, $0) }.joined(separator: "\n"),
         kept.skipped.isEmpty ? "" : "Not kept: \(kept.skipped.joined(separator: "; ")).",
        ].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    /// The sentences above the rows: the line on what it was making, then its last message when that says more (not
    /// "Done."), else the request as a sentence.
    public static func createdSentence(_ first: String?, _ last: String?, _ request: String?) -> String {
        let said = [first, last].map { ($0 ?? "").jsTrim }.filter { !$0.isEmpty && !JSRegex("^done\\.?$", "i").test($0) && !JSRegex("^ESCALATE:").test($0) }
        var unique: [String] = []
        for s in said where !unique.contains(s) { unique.append(s) }
        return unique.isEmpty ? requestSentence(request) : unique.joined(separator: "\n\n")
    }

    /// A request as the sentence that says what is being made: its asking words off, a capital, a full stop.
    public static func requestSentence(_ request: String?) -> String {
        var text = (request ?? "").squashedSpaces
        text = JSRegex("^(?:please\\s+)?(?:(?:can|could|would) you\\s+)?(?:please\\s+)?(?:make|create|draw|build|write|generate|produce|put together|design)\\s+(?:me\\s+|us\\s+)?", "i").replace(text, with: "")
        text = JSRegex("[?.!\\s]+$").replace(text, with: "")
        return text.isEmpty ? "" : text.jsSlice(0, 1).uppercased() + text.jsSlice(1) + "."
    }

    /// The library row a kept file was saved as, while the library still holds it.
    public static func savedRow(projectDir: String, askId: String, rel: String, library: CreatedLibrary) async throws -> LibraryRow? {
        guard let id = readSaved(try createdDir(projectDir, askId))[rel] else { return nil }
        return await library.row(id: id)
    }

    /// One kept file as the editor and the Stage show it (created-file): name, rel, type, ext, path, size, saved, missing,
    /// and its text (≤2 MB; svg as text) or its bytes (a picture, a pdf, a table, a document ≤20 MB); a page's picture
    /// when `snapshot` is given.
    public static func readCreated(projectDir: String, askId: String, rel: String, library: CreatedLibrary,
                                   snapshot: ((String, String) async throws -> Data)? = nil) async throws -> OJ {
        let file = try createdFile(projectDir, askId, rel)
        let e = ext(file), type = fileTypes[e] ?? "file"
        var out: [(String, OJ)] = [("name", .string((file as NSString).lastPathComponent)), ("rel", .string(rel)), ("type", .string(type)),
                                   ("ext", .string(e.isEmpty ? "" : String(e.dropFirst()))), ("path", .string(file)), ("size", 0), ("saved", .null), ("missing", false)]
        func set(_ k: String, _ v: OJ) { if let i = out.firstIndex(where: { $0.0 == k }) { out[i].1 = v } else { out.append((k, v)) } }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file, isDirectory: &isDir), !isDir.boolValue,
              let attrs = try? FileManager.default.attributesOfItem(atPath: file), let size = attrs[.size] as? Int else { set("missing", true); return .object(out) }
        set("size", .number(Double(size)))
        if let row = try await savedRow(projectDir: projectDir, askId: askId, rel: rel, library: library) { set("saved", ["id": .string(row.id), "name": .string(row.name)]) }
        if e == ".svg" || !["image", "pdf", "parquet", "xlsx", "docx"].contains(type) {
            if size <= 2 * 1024 * 1024, let data = FileManager.default.contents(atPath: file) { set("text", .string(String(decoding: data, as: UTF8.self))) }
        } else if size <= maxCreatedBytes, let data = FileManager.default.contents(atPath: file) {
            set("bytes", .string(data.base64EncodedString()))
        }
        if type == "html", let snapshot {
            let shot = ((try createdDir(projectDir, askId) as NSString).appendingPathComponent(previewsDir) as NSString)
                .appendingPathComponent("\(encodeRel(rel).replacingOccurrences(of: "/", with: "__")).png")
            if let png = try? await snapshot(file, shot) { set("preview", .string(png.base64EncodedString())) } else { set("preview", .null) }
        }
        return .object(out)
    }

    /// Save: a kept file into the library as a row of its own; saved already (and still in the library): that row.
    @discardableResult
    public static func saveCreated(projectDir: String, projectId: String, workspaceId: String?, askId: String, rel: String, library: CreatedLibrary) async throws -> LibraryRow {
        let file = try createdFile(projectDir, askId, rel), dir = try createdDir(projectDir, askId)
        if let held = try await savedRow(projectDir: projectDir, askId: askId, rel: rel, library: library) { return held }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file, isDirectory: &isDir), !isDir.boolValue else { throw Refused(message: "That file is gone") }
        guard let type = fileTypes[ext(file)] else { throw Refused(message: "The library does not keep that kind of file") }
        let row = try await library.saveCreated(projectId: projectId, workspaceId: workspaceId, file: file, name: rowName(file), type: type)
        let saved = OJ.object(savedPairs(dir)).setting(rel, .string(row.id))
        try writeJSONFile(URL(fileURLWithPath: (dir as NSString).appendingPathComponent(savedFile)), saved)
        return row
    }

    /// Every file a run kept, saved as its run ends, each on its own: one that fails stays unsaved (its row offers Save).
    public static func saveAllCreated(projectDir: String, projectId: String, workspaceId: String?, askId: String, files: [CreatedFile], library: CreatedLibrary) async {
        for file in files { _ = try? await saveCreated(projectDir: projectDir, projectId: projectId, workspaceId: workspaceId, askId: askId, rel: file.rel, library: library) }
    }
}

/// JS's default sort of strings: by UTF-16 code units.
func jsLess(_ a: String, _ b: String) -> Bool { Array(a.utf16).lexicographicallyPrecedes(Array(b.utf16)) }
