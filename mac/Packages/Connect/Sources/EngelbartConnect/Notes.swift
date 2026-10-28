import Foundation
import EngelbartCore

// Port of src/main/connect/notes.cjs (Connect your library, 2026-10-07): notes an import brings in. "Each file its own
// note in Engelbart with the same title, images included": a Markdown file becomes a Markdown copy of the library's own
// (<data root>/assets/md, since 2026-10-08) named by its file, its pictures copied beside it, and Obsidian's links to other
// notes (`[[Note]]`, `[[Note|shown]]`, `![[Note]]`) become Engelbart mentions (`@[Note]`), as do relative links to .md
// files (a Notion export's "Title 0123…cdef.md" read as "Title"). Staging (sessions from before 2026-10-08) is kept.

public struct ConvertedNote: Sendable, Equatable {
    public struct Image: Sendable, Equatable, Codable { public var token: String; public var file: String; public var alt: String }
    public var body: String
    public var images: [Image]
}

public enum Notes {
    public static let imageMimes = [".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"]
    static let pictureExt = #"\.(png|jpe?g|gif|webp|svg|heic|bmp|tiff?)$"#
    public static let maxNoteBytes = 5 * 1024 * 1024
    public static let maxImageBytes = 20 * 1024 * 1024
    static let maxIndex = 50_000
    static let notionHash = #"\s+[0-9a-f]{32}$"#

    static func ext(_ p: String) -> String { let e = (p as NSString).pathExtension; return e.isEmpty ? "" : "." + e }
    static func basename(_ p: String, dropExt: Bool = false) -> String {
        let b = (p as NSString).lastPathComponent
        return dropExt ? (b as NSString).deletingPathExtension : b
    }
    static func decodeURI(_ s: String) -> String { s.removingPercentEncoding ?? s }

    /// What a linked note is called in Engelbart: the file's name without its folder, extension or Notion's id.
    public static func noteName(_ target: String) -> String {
        let t = target.trimmingCharacters(in: .whitespacesAndNewlines)
        return Names.sanitize(JS.replace(basename(t, dropExt: true), notionHash, "", options: .caseInsensitive))
    }

    static func altText(_ value: String) -> String {
        JS.replace(JS.replace(value, #"[\]\n]"#, " "), #"\s+"#, " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A lookup by file name within a folder (Obsidian finds `![[x.png]]` anywhere in the vault), built once per folder.
    public final class Index: @unchecked Sendable {
        private var held: [String: [String: String]] = [:]
        private let lock = NSLock()
        public init() {}
        public func find(root: String, name: String) -> String? {
            if root.isEmpty { return nil }
            lock.lock(); defer { lock.unlock() }
            if held[root] == nil {
                var index: [String: String] = [:]
                var queue = [root]
                var seen = 0
                while !queue.isEmpty && seen < Notes.maxIndex {
                    let dir = queue.removeFirst()
                    guard let entries = try? FileManager.default.contentsOfDirectory(atPath: dir) else { continue }
                    for entry in entries {
                        seen += 1
                        if entry.hasPrefix(".") || entry == "node_modules" { continue }
                        let full = (dir as NSString).appendingPathComponent(entry)
                        if FolderAccess.isDir(full) { queue.append(full) } else if index[entry.lowercased()] == nil { index[entry.lowercased()] = full }
                    }
                }
                held[root] = index
            }
            return held[root]?[name.lowercased()]
        }
    }

    static func isFile(_ p: String) -> Bool { var d: ObjCBool = false; return FileManager.default.fileExists(atPath: p, isDirectory: &d) && !d.boolValue }

    /// Where a picture a note names is on disk: beside the note, from the vault's top, else anywhere in the vault by name.
    public static func findPicture(_ target: String, sourcePath: String = "", root: String = "", index: Index? = nil) -> String? {
        let clean = decodeURI((target.components(separatedBy: "#")[0].components(separatedBy: "|")[0]).trimmingCharacters(in: .whitespacesAndNewlines))
        if clean.isEmpty || JS.test(clean, "^[a-z][a-z0-9+.-]*:", options: .caseInsensitive) { return nil }
        var tries: [String] = []
        if clean.hasPrefix("/") { tries.append(clean) }
        if !sourcePath.isEmpty { tries.append(FolderAccess.resolve(((sourcePath as NSString).deletingLastPathComponent as NSString).appendingPathComponent(clean))) }
        if !root.isEmpty { tries.append(FolderAccess.resolve((root as NSString).appendingPathComponent(clean))) }
        for file in tries where isFile(file) { return file }
        return index?.find(root: root, name: basename(clean))
    }

    /// A Markdown text as an Engelbart note: Obsidian links and embeds read, pictures that are files on this Mac set aside
    /// as `images` whose token stands in the body until the picture is saved.
    public static func convertMarkdown(_ text: String, sourcePath: String = "", root: String = "", index: Index? = nil) -> ConvertedNote {
        var images: [ConvertedNote.Image] = []
        func picture(_ target: String, _ alt: String) -> String? {
            guard let file = findPicture(target, sourcePath: sourcePath, root: root, index: index), JS.test(file, pictureExt, options: .caseInsensitive) else { return nil }
            let token = "engelbart-image:\(images.count)"
            let a = altText(alt)
            images.append(.init(token: token, file: file, alt: a.isEmpty ? basename(file, dropExt: true) : a))
            return "![\(images[images.count - 1].alt)](\(token))"
        }
        var body = text
        // ![[picture.png|300]] or ![[Another note]]
        body = AppleNotes.sub(body, #"!\[\[([^\]\n|#]+)(#[^\]\n|]*)?(?:\|([^\]\n]*))?\]\]"#, options: []) { g in
            let target = g[1], shown = g[3]
            if JS.test(target.trimmingCharacters(in: .whitespacesAndNewlines), pictureExt, options: .caseInsensitive) {
                return picture(target, JS.test(shown.trimmingCharacters(in: .whitespacesAndNewlines), #"^\d+(x\d+)?$"#) ? "" : shown) ?? g[0]
            }
            return "@[\(noteName(target))]"
        }
        // [[Note]], [[Note#Heading]], [[Note|shown]]
        body = AppleNotes.sub(body, #"\[\[([^\]\n|#]+)(#[^\]\n|]*)?(?:\|([^\]\n]*))?\]\]"#, options: []) { g in "@[\(noteName(g[1]))]" }
        // ![alt](relative/picture.png "title")
        body = AppleNotes.sub(body, #"!\[([^\]\n]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\)"#, options: []) { g in
            JS.test(g[2], "^(https?:|data:|img:|engelbart-image:)", options: .caseInsensitive) ? g[0] : (picture(g[2], g[1]) ?? g[0])
        }
        // [Title](Other%20note%200123….md)
        body = AppleNotes.sub(body, #"(^|[^!@])\[([^\]\n]+)\]\(<?([^)\s>]+\.md)>?\)"#, options: [.caseInsensitive]) { g in
            JS.test(g[3], "^[a-z][a-z0-9+.-]*:", options: .caseInsensitive) ? g[0] : "\(g[1])@[\(noteName(decodeURI(g[3])))]"
        }
        return ConvertedNote(body: body, images: images)
    }

    public struct Picture: Sendable, Equatable { public var file: String; public var name: String }

    /// writeFile's half that needs no store: the pictures that can be kept named from their alt text (unique), the body
    /// linking them by name, the others named in brackets. The library then writes `<root>/assets/md/<id>/<name>.md`.
    public static func prepareFile(body: String, images: [ConvertedNote.Image]) -> (text: String, pictures: [Picture]) {
        var text = body
        var pictures: [Picture] = []
        var taken = Set<String>()
        for image in images {
            var replacement = "[picture: \(image.alt)]"
            let e = ext(image.file).lowercased()
            if imageMimes[e] != nil, isFile(image.file),
               let size = (try? FileManager.default.attributesOfItem(atPath: image.file))?[.size] as? Int, size <= maxImageBytes {
                var stem = JS.replace(image.alt, #"[^\w.-]+"#, "-")
                stem = String(JS.replace(stem, #"^[-.]+|-+$"#, "").prefix(60))
                if stem.isEmpty { stem = "picture" }
                var name = "\(stem)\(e)"
                var n = 2
                while taken.contains(name.lowercased()) { name = "\(stem)-\(n)\(e)"; n += 1 }
                taken.insert(name.lowercased())
                pictures.append(Picture(file: image.file, name: name))
                replacement = "![\(image.alt)](\(name))"
            }
            text = text.replacingOccurrences(of: "![\(image.alt)](\(image.token))", with: replacement)
        }
        return (text, pictures)
    }

    /// What an import brings in (2026-10-08: "save the imported content not as notes but as md files ... in the engelbart
    /// assets folder"): a Markdown copy of the library's own. → the library row.
    public static func writeFile(title: String, body: String, images: [ConvertedNote.Image] = [], about: JSONValue? = nil, library: ConnectStore) async throws -> LibraryRow {
        let prepared = prepareFile(body: body, images: images)
        return try await library.addMarkdownCopy(name: Names.sanitize(title), text: prepared.text, pictures: prepared.pictures, about: about)
    }

    // MARK: staging (sessions from before 2026-10-08)

    static func stagedDir(_ sessionDir: URL) -> URL { sessionDir.appendingPathComponent("notes") }

    /// A note kept until the session has a project. → its staged id
    @discardableResult
    public static func stageNote(_ sessionDir: URL, title: String, body: String, images: [ConvertedNote.Image] = [], source: String = "") throws -> String {
        let dir = stagedDir(sessionDir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let id = IDs.new()
        let value: JSONValue = ["title": .string(Names.sanitize(title)), "body": .string(body),
                                "images": .array(images.map { ["token": .string($0.token), "file": .string($0.file), "alt": .string($0.alt)] }),
                                "source": .string(source), "at": .string(Time.iso())]
        try Files.writeAtomically(value.text(), to: dir.appendingPathComponent("\(id).json"), mode: 0o600)
        return id
    }

    public struct Staged: Sendable { public var file: URL; public var title: String; public var body: String; public var images: [ConvertedNote.Image]; public var source: String; public var at: String }

    public static func stagedNotes(_ sessionDir: URL) -> [Staged] {
        let dir = stagedDir(sessionDir)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        return names.filter { $0.hasSuffix(".json") }.sorted().compactMap { name in
            let file = dir.appendingPathComponent(name)
            guard let v = Files.readJSON(file), case .object = v else { return nil }
            let images = (v["images"]?.array ?? []).map { ConvertedNote.Image(token: JS.string($0["token"]), file: JS.string($0["file"]), alt: JS.string($0["alt"])) }
            return Staged(file: file, title: JS.string(v["title"]), body: JS.string(v["body"]), images: images, source: JS.string(v["source"]), at: JS.string(v["at"]))
        }
    }

    /// How many notes wait for the project (counted, not read).
    public static func stagedCount(_ sessionDir: URL) -> Int {
        ((try? FileManager.default.contentsOfDirectory(atPath: stagedDir(sessionDir).path)) ?? []).filter { $0.hasSuffix(".json") }.count
    }

    /// Pictures saved into the project (`![alt](img:<id>)`); one that cannot be kept is named in brackets.
    public static func placeImages(projectId: String, body: String, images: [ConvertedNote.Image], projects: ConnectStore) async -> String {
        var text = body
        for image in images {
            var replacement = "[picture: \(image.alt)]"
            if let mime = imageMimes[ext(image.file).lowercased()], isFile(image.file),
               let data = FileManager.default.contents(atPath: image.file), data.count <= maxImageBytes,
               let id = try? await projects.saveImage(projectId: projectId, bytes: data, mime: mime, name: image.alt) {
                replacement = "![\(image.alt)](img:\(id))"
            }
            text = text.replacingOccurrences(of: "![\(image.alt)](\(image.token))", with: replacement)
        }
        return text
    }

    /// Every staged note written into the project, oldest first, each removed once it is in. → [(id, name)]
    public static func flushStaged(_ sessionDir: URL, projectId: String, projects: ConnectStore) async throws -> [(id: String, name: String)] {
        var written: [(String, String)] = []
        for staged in stagedNotes(sessionDir).sorted(by: { $0.at < $1.at }) {
            let text = await placeImages(projectId: projectId, body: staged.body, images: staged.images, projects: projects)
            let note = try await projects.createNote(projectId: projectId, name: staged.title, text: text)
            written.append(note)
            try? FileManager.default.removeItem(at: staged.file)
        }
        return written
    }
}
