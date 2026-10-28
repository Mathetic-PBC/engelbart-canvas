import Foundation
import EngelbartCore

/// A workspace's earlier versions (archive.cjs, 2026-09-25; B21-B22). Clear saves the document to
/// `<Workspace>/.archive/<UTC time>.md` and starts it blank, keeping the lines the caller keeps; beside it `<time>.json`
/// holds what the workspace had then (as ids). Everything the document mentioned is linked at Clear. Restore archives
/// the current document first, so nothing is ever overwritten.
public enum Archive {
    public static let archiveDir = ".archive"
    public static let imported = "Imported from Task:"
    static let buildIdPattern = "^[0-9a-f]{10}$"

    /// context/expand-mentions.cjs INLINE: the inline tokens of a line (math, images, agents, emphasis, links, mentions).
    static let inline = try! NSRegularExpression(pattern: #"(\$\$(?:[^$\n\\]|\\.)+?\$\$|\$(?=[^\s$])(?:[^$\n\\]|\\.)+?(?<!\s)\$(?!\d)|\\\$|!\[[^\]\n]*\]\(img:[\w-]+\)|\[\[build\]\]|@(?:[Bb]art|[Cc]hat|[Bb]rainstorm|[Oo]rient|[Dd]iscover|[Cc]reate)(?=\s|$)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|@\[[^\]\n]+\]\(ws:[\w-]+\)|@\[[^\]\n]+\]\(lib:[\w-]+(?::[\w.~%\/-]+)?\)|@\[[^\]\n]+\]\(zotero:(?:g[0-9]+:)?[A-Za-z0-9]+\)|@\[[^\]\n]+\]\(made:[\w-]+\/[\w.~%\/-]+\)|@\[[^\]\n]+\]|https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"*`])"#)

    /// `text.split(INLINE)`: the text between tokens and the tokens, in order.
    static func splitInline(_ text: String) -> [String] {
        let ns = text as NSString
        var out: [String] = [], last = 0
        for match in inline.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out.append(ns.substring(with: NSRange(location: last, length: match.range.location - last)))
            out.append(ns.substring(with: match.range))
            last = match.range.location + match.range.length
        }
        out.append(ns.substring(from: last))
        return out
    }

    static func pad(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }

    /// 2026-09-25T21-03-12Z: a moment, sortable, legal in a file name.
    public static func stampOf(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "UTC")!
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return "\(c.year!)-\(pad(c.month!))-\(pad(c.day!))T\(pad(c.hour!))-\(pad(c.minute!))-\(pad(c.second!))Z"
    }

    /// What a version is called in the sidebar: its first line with words in it, without its markdown.
    public static func titleOf(_ text: String) -> String {
        for raw in text.components(separatedBy: "\n") {
            var line = raw.replacingOccurrences(of: #"^\s*(#{1,3} |- \[[ xX]?\] |[-*] |> ?)"#, with: "", options: .regularExpression)
            line = line.replacingOccurrences(of: #"@\[([^\]\n]+)\](\((?:ws|lib|zotero):[^)\s]*\))?"#, with: "$1", options: .regularExpression)
            line = line.replacingOccurrences(of: #"!\[[^\]\n]*\]\([^)]*\)"#, with: "", options: .regularExpression)
            line = line.replacingOccurrences(of: "[*`]", with: "", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !line.isEmpty && trimmed.range(of: #"^(bart[~+?]?>|build>)"#, options: .regularExpression) == nil { return String(line.prefix(120)) }
        }
        return "Untitled"
    }

    /// The library rows and workspaces a document mentions, by the rule Copy uses: this project's row first for a shared name.
    public static func mentionsIn(_ ctx: StoreContext, _ projectId: String, _ text: String) throws -> (ids: [String], workspaces: [String]) {
        let rows = try ctx.libraryDb.list()
        var byName: [String: LibraryRow] = [:]
        for row in rows where row.type != "image" {
            let key = row.name.lowercased()
            if let held = byName[key], !(held.projectId != projectId && row.projectId == projectId) { continue }
            byName[key] = row
        }
        let images = Set(rows.filter { $0.type == "image" }.map(\.id))
        var ids: [String] = [], workspaces: [String] = []
        for token in splitInline(text) where !token.isEmpty {
            if let id = capture(token, #"^!\[[^\]\n]*\]\(img:([\w-]+)\)$"#) { if images.contains(id) && !ids.contains(id) { ids.append(id) }; continue }
            if let id = capture(token, #"^@\[[^\]\n]+\]\(ws:([\w-]+)\)$"#) { if !workspaces.contains(id) { workspaces.append(id) }; continue }
            guard token.hasPrefix("@["), token.hasSuffix("]") else { continue }
            if let row = byName[String(token.dropFirst(2).dropLast()).lowercased()], !ids.contains(row.id) { ids.append(row.id) }
        }
        return (ids, workspaces)
    }

    static func capture(_ text: String, _ pattern: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern), let m = re.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) else { return nil }
        return (text as NSString).substring(with: m.range(at: 1))
    }

    static func dir(_ workspace: Workspaces.Record) -> String { Paths.join(workspace.dir, archiveDir) }

    static func freeStamp(_ dir: String, _ date: Date) -> String {
        let base = stampOf(date)
        var stamp = base, n = 2
        while Paths.exists(Paths.join(dir, "\(stamp).md")) { stamp = "\(base)-\(n)"; n += 1 }
        return stamp
    }

    static func ids(_ list: [String]) -> JSONValue { .array(list.map { .string($0) }) }

    public struct Cleared: Codable, Equatable, Sendable {
        public var text: String
        public var archive: ArchiveEntry?
        public var linked: [String]
        /// write-doc's revision for the document (Store fills it).
        public var revision: Int?
    }

    /// Clear (B21). `keep(line)` names the lines the blank document keeps; a document with nothing else is not archived.
    @discardableResult
    public static func clearWorkspace(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String, keep: (String) -> Bool = { _ in false }, now: () -> Date = Date.init) throws -> Cleared {
        let workspace = try Workspaces.find(ctx, projectId, workspaceId).workspace
        let file = Paths.join(workspace.dir, "workspace.md")
        let text = (try? String(contentsOfFile: file, encoding: .utf8)) ?? ""
        let lines = text.components(separatedBy: "\n")
        let kept = lines.filter(keep)
        if lines.allSatisfy({ keep($0) || $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { return Cleared(text: text, archive: nil, linked: []) }
        let mentions = try mentionsIn(ctx, projectId, text)
        let folder = dir(workspace)
        try JSONFiles.makeDir(folder)
        let at = now()
        let stamp = freeStamp(folder, at)
        let entry = ArchiveEntry(file: stamp, clearedAt: Time.iso(at), title: titleOf(text))
        try JSONFiles.writeText(Paths.join(folder, "\(stamp).md"), text)
        try JSONFiles.write(Paths.join(folder, "\(stamp).json"), entry.json.merging([
            "context": ids(workspace.context), "removed": ids(workspace.removed), "mentions": ids(mentions.ids),
            "workspaces": ids(mentions.workspaces), "builds": ids(workspace.builds),
        ]))
        // What the document mentioned stays on the sidebar: linked, unless it had been thrown away.
        let linked = mentions.ids.filter { !workspace.context.contains($0) && !workspace.removed.contains($0) }
        let next = kept.isEmpty ? "" : kept.joined(separator: "\n") + "\n"
        try JSONFiles.writeText(file, next)
        try Workspaces.patch(ctx, projectId, workspaceId, ["context": ids(workspace.context + linked),
                                                         "archives": .array(Array((workspace.archives + [entry]).suffix(500)).map(\.json)),
                                                         "chars": .number(Double(next.utf16.count))])
        return Cleared(text: next, archive: entry, linked: linked)
    }

    /// A post-it added to a workspace (2026-09-27): its text becomes an archived version headed "Imported from Task:",
    /// with the Build's line under it; the document, its links and its edit time are left as they are.
    @discardableResult
    public static func importTask(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String, text: String, buildId: String, now: () -> Date = Date.init) throws -> ArchiveEntry {
        guard Projects.matches(buildId, buildIdPattern) else { throw StoreError.type("build id is invalid") }
        let workspace = try Workspaces.find(ctx, projectId, workspaceId).workspace
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let doc = "\(imported)\n\(body)\n\nbuild> \(buildId)\n"
        let mentions = try mentionsIn(ctx, projectId, body)
        let folder = dir(workspace)
        try JSONFiles.makeDir(folder)
        let at = now()
        let stamp = freeStamp(folder, at)
        let entry = ArchiveEntry(file: stamp, clearedAt: Time.iso(at), title: String("\(imported) \(titleOf(body))".prefix(120)))
        try JSONFiles.writeText(Paths.join(folder, "\(stamp).md"), doc)
        try JSONFiles.write(Paths.join(folder, "\(stamp).json"), entry.json.merging([
            "imported": ["buildId": .string(buildId)], "context": ids(workspace.context), "removed": ids(workspace.removed),
            "mentions": ids(mentions.ids), "workspaces": ids(mentions.workspaces), "builds": ids([buildId]),
        ]))
        try Workspaces.patch(ctx, projectId, workspaceId, ["archives": .array(Array((workspace.archives + [entry]).suffix(500)).map(\.json))])
        return entry
    }

    public struct Version: Equatable, Sendable { public var path: String; public var text: String; public var held: JSONValue? }

    static func file(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String, _ stamp: String, _ ext: String) throws -> String {
        guard Projects.matches(stamp, Projects.archivePattern) else { throw StoreError.type("archive is invalid") }
        return Paths.join(dir(try Workspaces.find(ctx, projectId, workspaceId).workspace), "\(stamp)\(ext)")
    }

    /// One archived version: where it is, its text, and what the workspace had then.
    public static func readArchive(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String, _ stamp: String) throws -> Version {
        let path = try file(ctx, projectId, workspaceId, stamp, ".md")
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { throw StoreError("That version is gone") }
        return Version(path: path, text: text, held: JSONFiles.read(String(path.dropLast(3)) + ".json"))
    }

    /// The newest archived version (a Build's <history>, B6), or nil.
    public static func latestArchive(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String) throws -> (entry: ArchiveEntry, version: Version)? {
        let workspace = try Workspaces.find(ctx, projectId, workspaceId).workspace
        for entry in workspace.archives.reversed() {
            if let version = try? readArchive(ctx, projectId, workspaceId, entry.file) { return (entry, version) }
        }
        return nil
    }

    /// Restore (B22): the current document archived (kept lines staying), the chosen version back with the kept lines after
    /// it, and what it had and mentioned linked again.
    @discardableResult
    public static func restoreArchive(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String, _ stamp: String, keep: (String) -> Bool = { _ in false }, now: () -> Date = Date.init) throws -> Cleared {
        let chosen = try readArchive(ctx, projectId, workspaceId, stamp)
        let cleared = try clearWorkspace(ctx, projectId, workspaceId, keep: keep, now: now)
        let chosenLines = chosen.text.components(separatedBy: "\n")
        let carried = cleared.text.components(separatedBy: "\n").filter { !$0.isEmpty && !chosenLines.contains($0) }
        var next = chosen.text
        if !carried.isEmpty {
            var body = chosen.text
            while body.hasSuffix("\n") { body.removeLast() }
            next = body + "\n" + carried.joined(separator: "\n") + "\n"
        }
        let workspace = try Workspaces.find(ctx, projectId, workspaceId).workspace
        try JSONFiles.writeText(Paths.join(workspace.dir, "workspace.md"), next)
        var back: [String] = []
        for id in (chosen.held?["context"]?.array ?? []) + (chosen.held?["mentions"]?.array ?? []) {
            if let id = id.string, !workspace.context.contains(id), !workspace.removed.contains(id), !back.contains(id) { back.append(id) }
        }
        try Workspaces.patch(ctx, projectId, workspaceId, ["context": ids(workspace.context + back), "chars": .number(Double(next.utf16.count))])
        return Cleared(text: next, archive: cleared.archive, linked: [])
    }
}
