import Foundation
import EngelbartCore

/// Engelbart's own tools for a Build's agent (engelbart-tools.cjs, 2026-10-07: a Build "should explicitly be able to save
/// files, duplicate files, or move a file into Engelbart"), served to Claude Code and Codex as the MCP server `engelbart`
/// over the loopback bridge, one bridge a turn. A file the agent writes into an Engelbart folder itself is not in the
/// library; these put it there, the way the person's own adding does. Each new item is linked to the Build's workspace.
/// Nothing here deletes or changes an item the library already holds.
public enum EngelbartTools {
    public static let saveFormats = ["md", "html", "csv", "tsv", "json", "jsonl"]
    static let maxText = 100_000 // what save_file takes: the bridge carries 128 KB a call
    static let maxNote: Int64 = 5 * 1024 * 1024
    static let maxFile: Int64 = 200 * 1024 * 1024
    public static let copiedImages = [".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"]

    /// The definitions, verbatim from engelbart-tools.cjs.
    public static let definitions: [MCPServer.Tool.Definition] = MCPServer.Tool.Definition.parse(#"[{"name":"save_file","description":"Save something you wrote into the person's Engelbart library, where they see it beside their notes and papers. format \"md\" (the default) makes a note of this project; html, csv, tsv, json and jsonl make a file Engelbart keeps. name: what the library calls it. content: the text, up to about 100 KB (for more, write the file and use move_file_into_engelbart). The new item is linked to this Build's workspace. Returns the item: id, name, type, path.","inputSchema":{"type":"object","properties":{"name":{"type":"string"},"content":{"type":"string"},"format":{"type":"string","enum":["md","html","csv","tsv","json","jsonl"]}},"required":["name","content"],"additionalProperties":false}},{"name":"duplicate_file","description":"Make a copy of an item in the person's Engelbart library, as an item of its own (a note becomes a new note, a paper a new paper). item: the item's id, or the path of its file (as <context_json> gives them). name: what the copy is called (default: the name with \" copy\"). Folders, repositories and web pages cannot be copied. Returns the new item.","inputSchema":{"type":"object","properties":{"item":{"type":"string"},"name":{"type":"string"}},"required":["item"],"additionalProperties":false}},{"name":"move_file_into_engelbart","description":"Move a file on this Mac into the person's Engelbart library: a paper you downloaded, a figure or a dataset you made. A pdf or a picture is kept as Engelbart's own copy, Markdown becomes a note of this project, html, csv, tsv, json, jsonl, docx, xlsx, parquet, heic and svg are kept as files. path: absolute, ~/…, or relative to your working directory. The file where it was is then removed, unless keep_original is true or it is the person's (their own folder, an Engelbart folder). The new item is linked to this Build's workspace. Returns the item and what became of the original.","inputSchema":{"type":"object","properties":{"path":{"type":"string"},"name":{"type":"string"},"keep_original":{"type":"boolean"}},"required":["path"],"additionalProperties":false}}]"#)

    /// Arguments as a tool's schema says, or an error.
    @discardableResult
    public static func validate(_ name: String, _ args: JSONValue) throws -> [String: JSONValue] {
        guard let tool = definitions.first(where: { $0.name == name }), let given = args.object else { throw BuildError("Unknown Engelbart tool") }
        let properties = tool.inputSchema["properties"]?.object ?? [:]
        let required = tool.inputSchema["required"]?.array?.compactMap(\.string) ?? []
        if required.contains(where: { given[$0] == nil }) || given.keys.contains(where: { properties[$0] == nil }) { throw BuildError("Invalid tool arguments") }
        for (key, value) in given {
            let type = properties[key]?["type"]?.string ?? "string"
            if type == "boolean" ? value.bool == nil : value.string == nil { throw BuildError("\(key) must be a \(type)") }
            if let options = properties[key]?["enum"]?.array?.compactMap(\.string), let s = value.string, !options.contains(s) {
                throw BuildError("\(key) must be one of \(options.joined(separator: ", "))")
            }
            if let s = value.string, s.contains("\0") || (key != "content" && s.count > 4096) { throw BuildError("\(key) is not valid") }
        }
        return given
    }

    static func real(_ file: String) -> String { NodePath.real(file) }
    static func stem(_ file: String) -> String { NodePath.basename(file, NodePath.extname(file)) }
    static func shown(_ row: LibraryRow) -> [String: JSONValue] {
        ["id": .string(row.id), "name": .string(row.name), "type": .string(row.type), "path": row.path.map(JSONValue.string) ?? .null]
    }

    /// A new folder for one kept file, under <data root>/assets/files/<uuid>/. → the file's path, not yet written
    static func keptFile(dataRoot: String, name: String, ext: String) throws -> String {
        let dir = NodePath.join(dataRoot, "assets", "files", IDs.new())
        try FS.mkdirs(dir, mode: 0o700)
        var base = Repository.sanitizeName(name)
        if base.lowercased().hasSuffix(ext.lowercased()) { base = String(base.dropLast(ext.count)) }
        return NodePath.join(dir, "\(base.isEmpty ? "Untitled" : base)\(ext)")
    }

    /// The tools for one turn of one Build. `task`: its record (workspaceId, cwd, worktree, repo, source);
    /// `onAdded(row)`: a row was made (the sidebar reads the library again). → call(name, args)
    public static func make(host: BuildHost, projectId: String, task: TaskRecord, onAdded: @escaping @Sendable (LibraryRow) -> Void = { _ in }) -> ToolBridge.Call {
        let home = host.homeDir
        let workspaceId = task.str("workspaceId")
        let cwd = task.str("cwd") ?? task.str("worktree") ?? home

        /// A path the agent gave: absolute, ~/…, file://…, or relative to its working directory.
        func whereOf(_ value: String) -> String {
            var file = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if file.lowercased().hasPrefix("file://"), let url = URL(string: file) { file = url.path }
            if file == "~" || file.hasPrefix("~/") { file = NodePath.join(home, String(file.dropFirst())) }
            return NodePath.resolve(cwd, file)
        }

        /// The row made: linked to the workspace (when there is one, and it is still there), announced.
        func made(_ row: LibraryRow) async -> LibraryRow {
            if let workspaceId { try? await host.linkToWorkspace(projectId, workspaceId, [row.id]) }
            onAdded(row)
            return row
        }

        func note(_ name: String, _ body: String) async throws -> LibraryRow {
            try await host.createNote(projectId, name: name, workspaceId: workspaceId, text: body)
        }

        /// `source` (a file of a format the library reads, not Markdown) kept by Engelbart as a new row named `name`.
        func keepCopy(_ source: String, _ name: String) async throws -> LibraryRow {
            let ext = NodePath.extname(source).lowercased()
            let type = host.libraryFileType(ext)
            if type == "pdf" || copiedImages[ext] != nil {
                guard let bytes = FileManager.default.contents(atPath: source) else { throw BuildError("\(source) could not be read") }
                return try await host.addFileCopy(bytes: bytes, mime: type == "pdf" ? "application/pdf" : copiedImages[ext]!, name: name)
            }
            let file = try keptFile(dataRoot: host.dataRoot, name: name, ext: ext)
            try Files.cloneItem(at: URL(fileURLWithPath: source), to: URL(fileURLWithPath: file))
            do { return try await host.addLibraryItem(file: file, name: name) }
            catch { FS.remove(NodePath.dirname(file)); throw error }
        }

        /// `source` kept by Engelbart as a new row named `name`.
        func keep(_ source: String, _ name: String?) async throws -> LibraryRow {
            var st = stat()
            guard stat(source, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else { throw BuildError("\(source) is not a file") }
            if Int64(st.st_size) > maxFile { throw BuildError("The file is larger than 200 MB") }
            let ext = NodePath.extname(source).lowercased()
            guard let type = host.libraryFileType(ext) else {
                var reads: [String] = []
                for e in host.libraryFileExtensions where !reads.contains(e) { reads.append(e) }
                throw BuildError("Engelbart does not keep \(ext.isEmpty ? "files without an extension" : ext) yet (it reads \(reads.joined(separator: " ")))")
            }
            if type == "md" {
                if Int64(st.st_size) > maxNote { throw BuildError("A note is at most 5 MB") }
                return try await note(name ?? stem(source), FS.readText(source) ?? "")
            }
            return try await keepCopy(source, name ?? stem(source))
        }

        return { name, raw in
            let args = try validate(name, raw)
            let s = { (k: String) in args[k]?.string }
            switch name {
            case "save_file":
                let content = s("content") ?? "", format = s("format") ?? "md", title = s("name") ?? ""
                if content.utf16.count > maxText { throw BuildError("content is at most 100 KB: write the file and use move_file_into_engelbart") }
                if format == "md" { return .object(shown(await made(try await note(title, content)))) }
                let file = try keptFile(dataRoot: host.dataRoot, name: title, ext: ".\(format)")
                try FS.write(file, content, mode: 0o600)
                do { return .object(shown(await made(try await host.addLibraryItem(file: file, name: title)))) }
                catch { FS.remove(NodePath.dirname(file)); throw error }
            case "duplicate_file":
                let item = (s("item") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let rows = await host.libraryRows()
                let isId = item.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: [.regularExpression, .caseInsensitive]) != nil
                let wanted = isId ? nil : real(whereOf(s("item") ?? ""))
                let row = wanted.map { w in rows.first { $0.path.map(real) == w } } ?? rows.first { $0.id == item }
                guard let row else { throw BuildError("\(s("item") ?? "") is not an item of the library (to bring a file in, use move_file_into_engelbart with keep_original)") }
                guard let path = row.path else { throw BuildError("“\(row.name)” has no file of its own (a folder, a repository or a web page) and cannot be copied") }
                return .object(shown(await made(try await keep(path, s("name") ?? "\(row.name) copy"))))
            default: // move_file_into_engelbart
                let source = whereOf(s("path") ?? "")
                if !FS.exists(source) { throw BuildError("Nothing is at \(source)") }
                let resolved = real(source)
                if let held = await host.libraryRows().first(where: { $0.path.map(real) == resolved }) {
                    throw BuildError("\(source) is already in the library as “\(held.name)” (use duplicate_file for a copy)")
                }
                let row = await made(try await keep(source, s("name")))
                var original = "kept, as asked"
                if args["keep_original"]?.bool != true {
                    let worktree = task.str("worktree").map(real)
                    let theirs = [task.str("repo"), task.str("source")].compactMap { $0 }.map(real)
                    let inWorktree = worktree.map { NodePath.inside($0, resolved) } ?? false
                    if !inWorktree && theirs.contains(where: { NodePath.inside($0, resolved) }) { original = "kept: it is in the person's own folder" }
                    else if !inWorktree && NodePath.inside(real(host.dataRoot), resolved) { original = "kept: it is in an Engelbart folder" }
                    else if Darwin.unlink(source) == 0 { original = "removed" }
                    else { original = "kept: it could not be removed (\(String(cString: strerror(errno))))" }
                }
                var out = shown(row)
                out["original"] = .string(original)
                return .object(out)
            }
        }
    }
}
