import Foundation
import EngelbartCore

/// Notes, pasted images, documents and typed paths (projects.cjs).
public enum Documents {
    /// stage/files.cjs BLOCKED: a read macOS refused.
    public static let blocked = "macOS blocked Engelbart from reading this file. Allow access in System Settings → Privacy & Security → Files and Folders."

    /// A failed stat or read of a person's file as they should hear it: nothing there, or blocked; anything else as it came.
    static func readFailure(_ error: Error) -> Error {
        if let failure = error as? POSIXFailure {
            if failure.code == ENOENT { return StoreError("Nothing is at that path") }
            if failure.code == EPERM || failure.code == EACCES { return StoreError(blocked) }
        }
        let ns = error as NSError
        if ns.domain == NSCocoaErrorDomain {
            if ns.code == NSFileReadNoSuchFileError || ns.code == NSFileNoSuchFileError { return StoreError("Nothing is at that path") }
            if ns.code == NSFileReadNoPermissionError { return StoreError(blocked) }
        }
        if ns.domain == NSPOSIXErrorDomain {
            if ns.code == Int(ENOENT) { return StoreError("Nothing is at that path") }
            if ns.code == Int(EPERM) || ns.code == Int(EACCES) { return StoreError(blocked) }
        }
        return error
    }

    static func reading<T>(_ read: () throws -> T) throws -> T {
        do { return try read() } catch { throw readFailure(error) }
    }

    /// Reads a whole file, with Node's errno codes.
    static func readData(_ path: String) throws -> Data {
        let fd = open(path, O_RDONLY)
        guard fd >= 0 else { throw POSIXFailure(code: errno, path: path) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do { return try handle.readToEnd() ?? Data() } catch { throw POSIXFailure(code: EIO, path: path) }
    }

    // MARK: notes

    /// The notes table keeps its first columns: `topic_id` holds the workspace id.
    @discardableResult
    public static func createNote(_ ctx: StoreContext, _ projectId: String, name: String? = nil, workspaceId: String? = nil, text: String? = nil) throws -> NoteInfo {
        let project = try Projects.find(ctx, projectId)
        if let workspaceId { try Ids.assert(workspaceId, "workspace") }
        let stem = Names.uniqueName(project.dir, Names.sanitizeName((name?.isEmpty == false) ? name : "Untitled Note 1"), ext: ".md")
        let file = Paths.join(project.dir, "\(stem).md")
        try JSONFiles.writeText(file, text ?? "")
        let id = IDs.new()
        let row = try NotesDB.open(projectDir: project.dir).insert(id: id, name: stem, path: "\(stem).md", goalId: nil, topicId: workspaceId)
        try ctx.libraryDb.insert(NewLibraryRow(id: id, name: stem, type: "md", tags: ["note"], path: file, projectId: projectId, about: AboutFields(source: "engelbart", category: "note")))
        try ctx.libraryDb.setCharCount(id, (text ?? "").utf16.count)
        return NoteInfo(row)
    }

    /// Where a note is kept (2026-10-16): in the project asked for, or, for a note of another project mentioned there, in
    /// the project its library row says made it.
    static func noteHome(_ ctx: StoreContext, _ projectId: String, _ noteId: String) throws -> (project: Projects.Record, notes: NotesDB, row: NoteRow) {
        let id = try Ids.assert(noteId, "note")
        var project = try Projects.find(ctx, projectId)
        var notes = try NotesDB.open(projectDir: project.dir)
        var row = try notes.get(id)
        if row == nil, let item = try ctx.libraryDb.get(id), let owner = item.projectId, owner != projectId,
           let other = Projects.records(ctx).first(where: { $0.id == owner }) {
            project = other
            notes = try NotesDB.open(projectDir: other.dir)
            row = try notes.get(id)
        }
        guard let row else { throw StoreError("Unknown note") }
        return (project, notes, row)
    }

    @discardableResult
    public static func renameNote(_ ctx: StoreContext, _ projectId: String, _ noteId: String, _ name: String) throws -> NoteInfo {
        let home = try noteHome(ctx, projectId, noteId)
        let base = Names.sanitizeName(name)
        if base == home.row.name { return NoteInfo(home.row) }
        let stem = Names.uniqueName(home.project.dir, base, ext: ".md")
        let file = Paths.join(home.project.dir, "\(stem).md")
        try FileManager.default.moveItem(atPath: Paths.join(home.project.dir, home.row.path), toPath: file)
        let updated = try home.notes.rename(noteId, name: stem, path: "\(stem).md")!
        try ctx.libraryDb.rename(noteId, stem)
        try ctx.libraryDb.updatePath(noteId, file)
        return NoteInfo(updated)
    }

    // MARK: images

    /// A pasted image: bytes → <project>/assets/<id>.<ext>, plus a library row (type `image`), referenced as
    /// `![Attachment n](img:<id>)`.
    @discardableResult
    public static func saveImage(_ ctx: StoreContext, _ projectId: String, bytes: Data, mime: String, name: String? = nil) throws -> LibraryRow {
        let project = try Projects.find(ctx, projectId)
        guard let ext = Projects.imageTypes[mime] else { throw StoreError.type("Only png, jpeg, gif and webp images can be attached") }
        guard !bytes.isEmpty, bytes.count <= Projects.maxImageBytes else { throw StoreError.type("The image is empty or larger than 20 MB") }
        let dir = Paths.join(project.dir, "assets")
        try JSONFiles.makeDir(dir)
        let id = IDs.new()
        let file = Paths.join(dir, "\(id).\(ext)")
        try JSONFiles.writeData(file, bytes)
        let label = Names.sanitizeName(name?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? name : "Attachment")
        return try ctx.libraryDb.insert(NewLibraryRow(id: id, name: label, type: "image", path: file, projectId: projectId, about: AboutFields(source: "engelbart", category: "image")))
    }

    public struct ImageBytes: Sendable { public var id: String; public var name: String; public var mime: String; public var bytes: Data }

    public static func readImage(_ ctx: StoreContext, _ id: String) throws -> ImageBytes {
        guard let row = try ctx.libraryDb.get(try Ids.assert(id, "image")), row.type == "image", let path = row.path else { throw StoreError("Unknown image") }
        let resolved = Paths.resolve(path)
        guard resolved.hasPrefix(ctx.dataRoot + "/") else { throw StoreError("The image is outside the data root") }
        let ext = Paths.extname(resolved).dropFirst().lowercased()
        let mime = Projects.imageTypes.first(where: { $0.value == ext })?.key ?? "application/octet-stream"
        return ImageBytes(id: row.id, name: row.name, mime: mime, bytes: try readData(resolved))
    }

    // MARK: documents

    enum Resolved { case note(file: String, row: NoteRow, notes: NotesDB), workspace(file: String, workspace: Workspaces.Record), project(file: String, project: Projects.Record) }

    static func resolveDoc(_ ctx: StoreContext, _ projectId: String, _ ref: DocRef) throws -> Resolved {
        switch ref {
        case .note(let id):
            let home = try noteHome(ctx, projectId, id)
            return .note(file: Paths.join(home.project.dir, home.row.path), row: home.row, notes: home.notes)
        case .workspace(let workspaceId):
            let found = try Workspaces.find(ctx, projectId, workspaceId)
            return .workspace(file: Paths.join(found.workspace.dir, "workspace.md"), workspace: found.workspace)
        case .project:
            let project = try Projects.find(ctx, projectId)
            return .project(file: Paths.join(project.dir, Projects.projectPage), project: project)
        }
    }

    /// The file a document is kept in.
    public static func docFile(_ ctx: StoreContext, _ projectId: String, _ ref: DocRef) throws -> String {
        switch try resolveDoc(ctx, projectId, ref) {
        case .note(let file, _, _), .workspace(let file, _), .project(let file, _): return file
        }
    }

    /// What every agent in the project reads first: the page as a block, or '' while it is empty or still says only the
    /// project's description.
    public static func projectPageBlock(_ project: Projects.Record) -> String {
        let text = ((try? String(contentsOfFile: Paths.join(project.dir, Projects.projectPage), encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty || text.collapsingWhitespaceKeepingEnds() == project.description.trimmingCharacters(in: .whitespacesAndNewlines).collapsingWhitespaceKeepingEnds() { return "" }
        let name = String(project.name.replacingOccurrences(of: #"[<>"\n\r]"#, with: " ", options: .regularExpression).prefix(200))
        return "<project_page name=\"\(name)\" note=\"The project page: what the person wants every agent in this project to know.\">\n\(text.prefix(20000))\n</project_page>"
    }

    public static func readDoc(_ ctx: StoreContext, _ projectId: String, _ ref: DocRef) throws -> String {
        let resolved = try resolveDoc(ctx, projectId, ref)
        // A project made before its page existed gets one the first time it is opened, from its description.
        if case .project(let file, let project) = resolved, !Paths.exists(file) { try JSONFiles.writeText(file, Projects.projectPageText(project.description)) }
        let file: String
        switch resolved { case .note(let f, _, _), .workspace(let f, _), .project(let f, _): file = f }
        return (try? String(contentsOfFile: file, encoding: .utf8)) ?? ""
    }

    /// A save that changes nothing is not an edit (→ lastEdited nil): last_edited decides when a summary is stale.
    @discardableResult
    public static func writeDoc(_ ctx: StoreContext, _ projectId: String, _ ref: DocRef, _ text: String) throws -> String? {
        guard text.utf16.count <= 5 * 1024 * 1024 else { throw StoreError.type("doc text must be a string under 5 MB") }
        let resolved = try resolveDoc(ctx, projectId, ref)
        let file: String
        switch resolved { case .note(let f, _, _), .workspace(let f, _), .project(let f, _): file = f }
        if let previous = try? String(contentsOfFile: file, encoding: .utf8), previous == text { return nil }
        try JSONFiles.writeText(file, text)
        switch resolved {
        case .note(_, let row, let notes):
            try notes.touch(row.id)
            try ctx.libraryDb.recordEdit(row.id, text.utf16.count) // the note's character count, current with every save
        case .workspace(_, let workspace):
            try Workspaces.patchMeta(workspace.dir, ["chars": .number(Double(text.utf16.count))])
        case .project: break
        }
        return Time.iso()
    }

    // MARK: typed paths (the Browser pane's file mode)

    /// A typed path, made real: file://, ~/…, absolute, else relative to the project, the engelbart folder, the root, then
    /// the project's code directory (the first that exists). Home directory only.
    public static func resolveTypedPath(_ ctx: StoreContext, _ project: Projects.Record, _ input: String) throws -> String {
        guard !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, input.count <= 4096, !input.contains("\0") else { throw StoreError.type("path is invalid") }
        var target = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if target.lowercased().hasPrefix("file://"), let path = Paths.fromFileURL(target) { target = path }
        let candidates: [String]
        if target.hasPrefix("~/") { candidates = [Paths.join(ctx.homeDir, String(target.dropFirst(2)))] }
        else if target == "~" { candidates = [ctx.homeDir] }
        else if target.hasPrefix("/") { candidates = [target] }
        else { candidates = [project.dir, ctx.dataRoot, ctx.root, project.directory].compactMap { $0 }.map { Paths.join($0, target) } }
        let chosen = candidates.first(where: { Paths.exists($0) || Paths.isSymlink($0) }) ?? candidates[0]
        let resolved = try reading { try Paths.real(chosen) }
        let home = try Paths.real(ctx.homeDir)
        guard resolved == home || resolved.hasPrefix(home + "/") else { throw StoreError("Only files inside your home directory can be opened") }
        return resolved
    }

    public struct PageFile: Codable, Equatable, Sendable { public var path: String; public var url: String }

    /// What the Browser pane renders rather than prints: an html file or a pdf that exists; else nil.
    public static func resolvePageFile(_ ctx: StoreContext, _ projectId: String, _ input: String) throws -> PageFile? {
        let project = try Projects.find(ctx, projectId)
        let typed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        var tries = [(typed, "")]
        if let cut = typed.firstIndex(where: { $0 == "#" || $0 == "?" }), cut > typed.startIndex {
            tries.append((String(typed[..<cut]), String(typed[cut...])))
        }
        for (file, rest) in tries {
            guard let resolved = try? resolveTypedPath(ctx, project, file) else { continue }
            if resolved.range(of: #"\.(?:html?|pdf)$"#, options: [.regularExpression, .caseInsensitive]) != nil, Paths.stat(resolved)?.isFile == true {
                return PageFile(path: resolved, url: Paths.fileURL(resolved) + rest)
            }
        }
        return nil
    }

    public struct TextFile: Codable, Equatable, Sendable {
        public var path: String
        public var text: String
        public var truncated: Bool
        public var kind: String
    }

    public static func readProjectTextFile(_ ctx: StoreContext, _ projectId: String, _ input: String) throws -> TextFile {
        let resolved = try resolveTypedPath(ctx, try Projects.find(ctx, projectId), input)
        let info = try reading { try Paths.statOrThrow(resolved) }
        if info.isDirectory {
            let entries = (Paths.listDir(resolved) ?? []).map { $0 + (Paths.isRealDirectory(Paths.join(resolved, $0)) ? "/" : "") }.sorted()
            return TextFile(path: resolved, text: entries.joined(separator: "\n"), truncated: false, kind: "directory")
        }
        guard info.isFile, info.size <= 2 * 1024 * 1024 else { throw StoreError("The file is not a readable text file") }
        let text = String(decoding: try reading { try readData(resolved) }, as: UTF8.self)
        let units = Array(text.utf16)
        return TextFile(path: resolved, text: units.count > 20000 ? String(decoding: units.prefix(20000), as: UTF16.self) : text, truncated: units.count > 20000, kind: "file")
    }
}

extension String {
    /// `replace(/\s+/g, ' ')` without trimming.
    func collapsingWhitespaceKeepingEnds() -> String { replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression) }
}
