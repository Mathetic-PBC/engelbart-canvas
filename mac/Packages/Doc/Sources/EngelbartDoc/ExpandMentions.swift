import Foundation

// A document as one text that stands on its own outside Engelbart (src/main/context/expand-mentions.cjs): what the
// sidebar's Copy puts on the clipboard and what an agent is given (2026-09-19). Every mentioned file is placed directly
// under the line that mentions it, in <file> tags, once: at its first mention reading top to bottom. A note is included
// whole and brings its own mentions; anything else is where it is plus its catalog summary. A mentioned workspace is
// included as a note is. A mention that leads nowhere says so where it stands. A pasted image becomes the path of its
// file. A Zotero item is its <zotero_item> block. The tokens are the editor's own (Inline.INLINE: one definition), so a
// mention inside `code` or a formula stays text here as it does on screen.
//
// The Store, the Build store and the Zotero mirror are not this package's: `MentionSource` is how the app gives them.

/// A file inside a library folder (store/folder-files.cjs fileInRow's answer).
public struct FolderFile: Equatable, Sendable {
    public var exists: Bool
    public var dir: Bool
    public var type: String?
    public var folder: String
    public var path: String
    public init(exists: Bool, dir: Bool = false, type: String? = nil, folder: String, path: String) { self.exists = exists; self.dir = dir; self.type = type; self.folder = folder; self.path = path }
}

/// A Zotero item's block (zotero/mirror.cjs mentionBlock).
public struct ZoteroBlock: Equatable, Sendable {
    public var missing: Bool
    public var lines: [String]
    public var file: String?
    public init(missing: Bool, lines: [String], file: String? = nil) { self.missing = missing; self.lines = lines; self.file = file }
}

/// Where mentions lead. `find(name)` a library row by name; `get(id)` the row a `lib:<id>` mention names (nil: the source
/// cannot tell by id, and the name is used); `read(row)` a note's text (nil when its file cannot be read); `image(id)` a
/// pasted image's file; `workspace(id)` a workspace of the project; `file(folderId, rel)` a file in a library folder;
/// `zotero(ref, name)` a Zotero item's block.
public struct MentionSource {
    public var find: (String) -> LibRow?
    public var get: ((String) -> LibRow?)?
    public var read: (LibRow) async -> String?
    public var image: (String) -> String?
    public var workspace: ((String) async -> (name: String, path: String?, text: String)?)?
    public var file: ((String, String) -> FolderFile?)?
    public var zotero: ((String, String) async -> ZoteroBlock?)?
    public init(find: @escaping (String) -> LibRow?, get: ((String) -> LibRow?)? = nil, read: @escaping (LibRow) async -> String?,
                image: @escaping (String) -> String? = { _ in nil }, workspace: ((String) async -> (name: String, path: String?, text: String)?)? = nil,
                file: ((String, String) -> FolderFile?)? = nil, zotero: ((String, String) async -> ZoteroBlock?)? = nil) {
        self.find = find; self.get = get; self.read = read; self.image = image; self.workspace = workspace; self.file = file; self.zotero = zotero
    }

    /// Where the mentions of a project's documents lead, from the library's rows (expand-mentions.cjs projectSource): two
    /// projects can each hold a file of the same name, and this project's is the one meant. Pictures are found by id only.
    public static func project(_ projectId: String?, rows: [LibRow], read: @escaping (LibRow) async -> String?,
                               workspace: ((String) async -> (name: String, path: String?, text: String)?)? = nil,
                               file: ((String, String) -> FolderFile?)? = nil, zotero: ((String, String) async -> ZoteroBlock?)? = nil) -> MentionSource {
        var byName: [String: LibRow] = [:]
        for row in rows where row.type != "image" {
            let key = row.name.lowercased()
            if let held = byName[key] { if held.projectId != projectId && row.projectId == projectId { byName[key] = row } } else { byName[key] = row }
        }
        var images: [String: String] = [:]
        for row in rows where row.type == "image" { if let p = row.path { images[row.id] = p } }
        var byId: [String: LibRow] = [:]
        for row in rows { byId[row.id] = row }
        return MentionSource(find: { byName[$0.lowercased()] }, get: { byId[$0] }, read: read, image: { images[$0] }, workspace: workspace,
                             file: file.map { f in { folderId, rel in byId[folderId]?.folderPath != nil ? f(folderId, rel) : nil } }, zotero: zotero)
    }
}

/// What is already placed (expand-mentions' `seen`, a JS Set): keys in the order they were first added, as a JS Set
/// iterates, so a caller reading them back (Bart's context, which sends what it placed in order) gets that order.
public struct SeenKeys: Equatable, Sequence, ExpressibleByArrayLiteral, Sendable {
    public private(set) var keys: [String] = []
    private var held = Set<String>()
    public init() {}
    public init<S: Sequence>(_ keys: S) where S.Element == String { for k in keys { insert(k) } }
    public init(arrayLiteral elements: String...) { self.init(elements) }
    public func contains(_ key: String) -> Bool { held.contains(key) }
    /// Added at the end unless already held (a JS Set's add): → whether it was new.
    @discardableResult public mutating func insert(_ key: String) -> Bool {
        guard held.insert(key).inserted else { return false }
        keys.append(key); return true
    }
    public var count: Int { keys.count }
    public var isEmpty: Bool { keys.isEmpty }
    public func makeIterator() -> IndexingIterator<[String]> { keys.makeIterator() }
    public static func == (a: SeenKeys, b: SeenKeys) -> Bool { a.keys == b.keys }
}

public enum ExpandMentions {
    public static var INLINE: Rx { Inline.INLINE }
    static let IMAGE_TOKEN = Rx(#"^!\[([^\]\n]*)\]\(img:([\w-]+)\)$"#)
    static let BART_NAME = Rx(#"^bart"#, "i")
    static let BUILD_LINE = Rx(#"^build> ([0-9a-f]{10})$"#)

    /// The key a mentioned file is kept under in `seen` (bart/context.cjs mentionedFiles reads them back).
    public static func fileKey(_ folderId: String, _ rel: String) -> String { "file:\(folderId):\(rel)" }
    /// The key a mentioned Zotero item's file is kept under in `seen`.
    public static func zoteroFileKey(_ file: String) -> String { "zfile:\(file)" }

    static func attr(_ v: String) -> String { v.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "<", with: "&lt;") }
    static func bare(_ text: String?) -> String { Rx(#"^\n+"#).replace((text ?? "").replacingOccurrences(of: "\r", with: ""), with: "").trimEnd }

    static func openTag(_ row: LibRow) -> String {
        var parts = ["name=\"\(attr(row.name))\"", "type=\"\(attr(row.type))\""]
        if !row.tags.isEmpty { parts.append("tags=\"\(attr(row.tags.joined(separator: " ")))\"") }
        if let p = row.path, !p.isEmpty { parts.append("path=\"\(attr(p))\"") }
        if let f = row.folderPath, !f.isEmpty { parts.append("folder=\"\(attr(f))\"") }
        if let u = row.url, !u.isEmpty { parts.append("url=\"\(attr(u))\"") }
        return "<file \(parts.joined(separator: " "))"
    }

    public struct Tally: Equatable { public var files = 0; public var missing = 0 }
    public struct Result: Equatable { public var lines: [String]; public var files: Int; public var missing: Int }

    static func fileBlock(_ row: LibRow, _ source: MentionSource, _ seen: inout SeenKeys, _ tally: inout Tally) async -> [String] {
        if Kind.isNote(row) {
            guard let text = await source.read(row) else { tally.missing += 1; return ["\(openTag(row)) missing=\"true\" />"] }
            tally.files += 1
            return ["\(openTag(row))>"] + (await expandLines(text, source, &seen, &tally)) + ["</file>"]
        }
        tally.files += 1
        let summary = bare(row.summary)
        return summary.isEmpty ? ["\(openTag(row)) />"] : ["\(openTag(row)) contains=\"summary\">"] + summary.jsSplit("\n") + ["</file>"]
    }

    static func folderFileBlock(_ name: String, _ folderId: String, _ rel: String, _ source: MentionSource, _ tally: inout Tally) -> [String] {
        let found = source.file?(folderId, rel)
        guard let f = found, f.exists else {
            tally.missing += 1
            return ["<file name=\"\(attr(name))\"\(found.map { " folder=\"\(attr($0.folder))\" path=\"\(attr($0.path))\"" } ?? "") missing=\"true\" />"]
        }
        tally.files += 1
        return ["<file name=\"\(attr(name))\" type=\"\(attr(f.dir ? "folder" : (f.type ?? "file")))\" folder=\"\(attr(f.folder))\" path=\"\(attr(f.path))\" />"]
    }

    static func zoteroBlock(_ name: String, _ key: String, _ source: MentionSource, _ seen: inout SeenKeys, _ tally: inout Tally) async -> [String] {
        let found = await source.zotero?(key, name)
        guard let z = found, !z.missing else {
            tally.missing += 1
            return found?.lines ?? ["<zotero_item key=\"\(attr(key))\" title=\"\(attr(name))\" missing=\"true\" />"]
        }
        tally.files += 1
        if let file = z.file { seen.insert(zoteroFileKey(file)) }
        return z.lines
    }

    static func workspaceBlock(_ name: String, _ id: String, _ source: MentionSource, _ seen: inout SeenKeys, _ tally: inout Tally) async -> [String] {
        guard let held = await source.workspace?(id) else { tally.missing += 1; return ["<file name=\"\(attr(name))\" type=\"workspace\" missing=\"true\" />"] }
        tally.files += 1
        let open = "<file name=\"\(attr(held.name))\" type=\"workspace\"\(held.path.map { " path=\"\(attr($0))\"" } ?? "")>"
        return [open] + (await expandLines(held.text, source, &seen, &tally)) + ["</file>"]
    }

    static func expandLines(_ text: String, _ source: MentionSource, _ seen: inout SeenKeys, _ tally: inout Tally) async -> [String] {
        let body = bare(text)
        var out: [String] = []
        var placed = false
        let lines = body.isEmpty ? [] : body.jsSplit("\n")
        // A picture pasted into this text is given where it is pasted: a mention of the same picture places nothing more.
        for line in lines { for token in Inline.INLINE.split(line) { if let image = IMAGE_TOKEN.match(token), source.image(image[2]!) != nil { seen.insert(image[2]!) } } }
        for line in lines {
            var blocks: [[String]] = []
            var shown = ""
            for token in Inline.INLINE.split(line) where !token.isEmpty {
                if let image = IMAGE_TOKEN.match(token) {
                    if let file = source.image(image[2]!) { shown += "![\(image[1] ?? "")](\(file))" } else { shown += token }
                    continue
                }
                shown += token
                if let ws = Inline.WS_MENTION.match(token) {
                    let key = "ws:\(ws[2]!)"
                    if seen.contains(key) { continue }
                    seen.insert(key)
                    blocks.append(await workspaceBlock(ws[1]!, ws[2]!, source, &seen, &tally))
                    continue
                }
                if let z = Inline.ZOTERO_MENTION.match(token) {
                    let key = "zotero:\(z[2]!)"
                    if seen.contains(key) { continue }
                    seen.insert(key)
                    blocks.append(await zoteroBlock(z[1]!, z[2]!, source, &seen, &tally))
                    continue
                }
                if let f = Inline.FILE_MENTION.match(token) {
                    // A file in a library folder (MATH-22): where it is, under the line. Its folder counts as mentioned.
                    let folderId = f[2]!, rel = Inline.decodeRel(f[3]), key = fileKey(folderId, rel)
                    seen.insert(folderId)
                    if seen.contains(key) { continue }
                    seen.insert(key)
                    blocks.append(folderFileBlock(f[1]!, folderId, rel, source, &tally))
                    continue
                }
                if !token.hasPrefix("@[") { continue }
                let lib = Inline.LIB_MENTION.match(token)
                let name = lib?[1] ?? token.slice(2, -1)
                // A library mention is its item, by id (else, with a source that cannot tell, by name).
                let row: LibRow? = { if let lib, let get = source.get { return get(lib[2]!) }; return source.find(name) }()
                let key = row?.id ?? "?\(name.lowercased())"
                if seen.contains(key) || (row == nil && BART_NAME.test(name)) { continue }
                seen.insert(key)
                if let row { blocks.append(await fileBlock(row, source, &seen, &tally)) }
                else { tally.missing += 1; blocks.append(["<file name=\"\(attr(name))\" missing=\"true\" />"]) }
            }
            if placed && !shown.trimmed.isEmpty { out.append("") }
            placed = false
            out.append(shown)
            for block in blocks {
                if out.last != "" { out.append("") }
                out += block
                placed = true
            }
        }
        return out
    }

    /// `text` with its mentions in place. `seen` holds what is already included and comes back holding every key placed.
    public static func expandMentions(_ text: String, _ source: MentionSource, seen: inout SeenKeys) async -> Result {
        var tally = Tally()
        let lines = await expandLines(text, source, &seen, &tally)
        return Result(lines: lines, files: tally.files, missing: tally.missing)
    }

    public static func expandMentions(_ text: String, _ source: MentionSource) async -> Result {
        var seen = SeenKeys()
        return await expandMentions(text, source, seen: &seen)
    }

    /// Library rows placed as if each were mentioned on a line of its own (a Build's attached items).
    public static func expandRows(_ rows: [LibRow], _ source: MentionSource, seen: inout SeenKeys) async -> Result {
        var tally = Tally()
        var lines: [String] = []
        for row in rows {
            if seen.contains(row.id) { continue }
            seen.insert(row.id)
            if !lines.isEmpty { lines.append("") }
            lines += await fileBlock(row, source, &seen, &tally)
        }
        return Result(lines: lines, files: tally.files, missing: tally.missing)
    }

    /// One line of text with each pasted image as the path of its file; nothing else is touched (an agent's question).
    public static func imagePaths(_ text: String?, _ source: MentionSource) -> String {
        Inline.INLINE.split(text ?? "").map { token in
            if let image = IMAGE_TOKEN.match(token), let file = source.image(image[2]!) { return "![\(image[1] ?? "")](\(file))" }
            return token
        }.joined()
    }

    /// A Build's line read as what its card says (`Build "<title>" (<status>)`); `task(id)` is the Build store's record.
    public static func buildLines(_ text: String, task: (String) -> (title: String, status: String)?) -> String {
        (text).jsSplit("\n").map { line in
            if let m = BUILD_LINE.match(line.trimmed), let t = task(m[1]!) { return "Build \"\(t.title)\" (\(t.status))" }
            return line
        }.joined(separator: "\n")
    }

    /// The document under its name, with its mentions in place (expandDoc's composition; the Store reads the document and
    /// names it). → (title, body, text, chars, files, missing).
    public static func expandDoc(title: String, body: String, source: MentionSource, seen: inout SeenKeys, task: (String) -> (title: String, status: String)? = { _ in nil }) async -> (title: String, body: String, text: String, chars: Int, files: Int, missing: Int) {
        let r = await expandMentions(buildLines(body, task: task), source, seen: &seen)
        let text = ((title.isEmpty ? [] : ["# \(title)", ""]) + r.lines).joined(separator: "\n").trimEnd
        return (title, r.lines.joined(separator: "\n").trimEnd, text, text.len, r.files, r.missing)
    }
}
