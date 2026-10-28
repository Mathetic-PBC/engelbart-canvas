import Foundation
import EngelbartCore

/// The files inside a library folder (folder-files.cjs, MATH-22): listed live a level at a time for the @ menu, and a
/// mentioned file `@[Name](lib:<folderId>:<path>)` found again by its folder's row and its path inside it. No dotfiles,
/// no node_modules, only the formats the library knows; nothing leaves the folder (symlinks followed only inside it).
public enum FolderFiles {
    public static let maxEntries = 2000
    static let maxRel = 4096
    static let maxBatch = 200
    static let skip: Set<String> = Library.peekSkip.union(["node_modules"])

    public struct Entry: Codable, Equatable, Sendable { public var name: String; public var rel: String; public var dir: Bool; public var type: String }
    public struct Level: Codable, Equatable, Sendable {
        public var id: String; public var name: String; public var rel: String; public var missing: Bool; public var entries: [Entry]; public var total: Int
    }
    public struct File: Codable, Equatable, Sendable {
        public var folderId: String; public var folder: String; public var rel: String; public var type: String?
        public var path: String; public var exists: Bool; public var dir: Bool
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(folderId, forKey: .folderId); try c.encode(folder, forKey: .folder); try c.encode(rel, forKey: .rel); try c.encode(type, forKey: .type)
            try c.encode(path, forKey: .path); try c.encode(exists, forKey: .exists); try c.encode(dir, forKey: .dir)
        }
        enum CodingKeys: String, CodingKey { case folderId, folder, rel, type, path, exists, dir }
    }
    public struct Seen: Codable, Equatable, Sendable { public var folderId: String; public var rel: String; public var exists: Bool; public var dir: Bool }

    /// A path inside a folder as given → its segments, or a TypeError for one that could leave the folder.
    public static func segments(_ rel: String?) throws -> [String] {
        guard let rel, !rel.isEmpty else { return [] }
        if rel.count > maxRel || rel.contains("\0") { throw StoreError.type("path is invalid") }
        if rel.hasPrefix("/") || rel.contains("\\") { throw StoreError.type("path must be relative to its folder") }
        let parts = rel.split(separator: "/").map(String.init).filter { !$0.isEmpty && $0 != "." }
        if parts.contains("..") { throw StoreError.type("path must stay inside its folder") }
        return parts
    }

    /// The folder row `id` names → (row, root): root its real path, nil when not on this Mac (or not in home).
    static func folderOf(_ ctx: StoreContext, _ id: String) throws -> (row: LibraryRow, root: String?) {
        guard Projects.matches(id, #"^[\w-]{1,64}$"#) else { throw StoreError.type("library id is invalid") }
        guard let row = try ctx.libraryDb.get(id) else { throw StoreError("Unknown library item") }
        guard let folderPath = row.folderPath else { throw StoreError("This item is not a folder on this Mac") }
        let home = Paths.realOrNil(ctx.homeDir) ?? Paths.resolve(ctx.homeDir)
        let root = Paths.realOrNil(folderPath)
        let ok = root.map { Paths.stat($0)?.isDirectory == true && Paths.inside($0, home) } ?? false
        return (row, ok ? root : nil)
    }

    /// `rel` inside `root` → its real path, or nil when nothing is there; throws when it ends outside the folder.
    public static func resolveInside(_ root: String, _ rel: String) throws -> String? {
        let parts = try segments(rel)
        guard let real = Paths.realOrNil(Paths.join([root] + parts)) else { return nil }
        if !Paths.inside(real, root) { throw StoreError("That path leaves its folder") }
        return real
    }

    static func typeOf(_ name: String) -> String? { Library.fileTypes[Paths.extname(name).lowercased()] }

    /// One level of a library folder for the @ menu: subfolders first, then files, each by name; `total` before the cap.
    public static func listFolder(_ ctx: StoreContext, _ id: String, _ rel: String = "") throws -> Level {
        let parts = try segments(rel)
        let (row, root) = try folderOf(ctx, id)
        var out = Level(id: row.id, name: row.name, rel: parts.joined(separator: "/"), missing: false, entries: [], total: 0)
        guard let root else { out.missing = true; return out }
        guard let dir = try resolveInside(root, out.rel), Paths.stat(dir)?.isDirectory == true, let names = Paths.listDir(dir) else { out.missing = true; return out }
        var entries: [Entry] = []
        for name in names {
            if name.hasPrefix(".") || skip.contains(name) { continue }
            let full = Paths.join(dir, name)
            var isDir = Paths.isRealDirectory(full), isFile = !isDir && !Paths.isSymlink(full) && Paths.stat(full)?.isFile == true
            if Paths.isSymlink(full) {
                // Followed, it must land inside the folder; a link out of it (or a broken one) is not listed.
                guard let real = Paths.realOrNil(full), Paths.inside(real, root), let info = Paths.stat(real) else { continue }
                isDir = info.isDirectory; isFile = info.isFile
            }
            let at = (parts + [name]).joined(separator: "/")
            if isDir { entries.append(Entry(name: name, rel: at, dir: true, type: "folder")) }
            else if isFile, let type = typeOf(name) { entries.append(Entry(name: name, rel: at, dir: false, type: type)) }
        }
        entries = entries.stableSorted { a, b in a.dir != b.dir ? a.dir : a.name.localizedCompare(b.name) == .orderedAscending }
        out.entries = Array(entries.prefix(maxEntries))
        out.total = entries.count
        return out
    }

    /// A mentioned file → { folderId, folder, rel, path, exists, dir, type }; a path that leaves the folder throws.
    public static func folderFile(_ ctx: StoreContext, _ id: String, _ rel: String) throws -> File {
        if try segments(rel).isEmpty { throw StoreError.type("path is invalid") }
        return try fileInRow(try folderOf(ctx, id).row, rel, homeDir: ctx.homeDir)
    }

    /// folderFile's answer from a row already read, without a database.
    public static func fileInRow(_ row: LibraryRow, _ rel: String, homeDir: String) throws -> File {
        let parts = try segments(rel)
        guard !parts.isEmpty, let folderPath = row.folderPath else { throw StoreError.type("path is invalid") }
        let home = Paths.realOrNil(homeDir) ?? Paths.resolve(homeDir)
        var root = Paths.realOrNil(folderPath)
        if let r = root, !(Paths.stat(r)?.isDirectory == true && Paths.inside(r, home)) { root = nil }
        let joined = parts.joined(separator: "/")
        guard let root else {
            return File(folderId: row.id, folder: row.name, rel: joined, type: typeOf(parts.last!), path: Paths.join([Paths.resolve(folderPath)] + parts), exists: false, dir: false)
        }
        let real = try resolveInside(root, joined)
        let info = real.flatMap(Paths.stat)
        return File(folderId: row.id, folder: row.name, rel: joined, type: typeOf(parts.last!), path: real ?? Paths.join([root] + parts),
                    exists: info.map { $0.isFile || $0.isDirectory } ?? false, dir: info?.isDirectory ?? false)
    }

    /// Many at once (the lines on screen), a failure as not there; at most 200.
    public static func folderFiles(_ ctx: StoreContext, _ list: [(folderId: String?, rel: String?)]) -> [Seen] {
        list.prefix(maxBatch).map { item in
            if let id = item.folderId, let rel = item.rel, let found = try? folderFile(ctx, id, rel) {
                return Seen(folderId: id, rel: rel, exists: found.exists, dir: found.dir)
            }
            return Seen(folderId: item.folderId ?? "", rel: item.rel ?? "", exists: false, dir: false)
        }
    }
}
