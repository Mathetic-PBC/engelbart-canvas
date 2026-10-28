import Foundation

/// Papers a Build cannot lose (keep.cjs, 2026-10-07: a Build may write outside its copy, "but it should not be able [to
/// delete] papers … It should be able to delete code files of course"). Not a wall, but what holds after any turn:
///   before a turn  every file the library holds and the ink on them (<data root>/annotations) is kept aside as a hard
///                  link; a file on another volume is copied when it is at most 20 MB. (APFS clonefile would also do; a
///                  link is what the Electron code made, and what the tests read.)
///   after it       one that is gone is put back, and so is a paper or a picture, or any file in the folders where
///                  Engelbart keeps its saved copies, that another file replaced. A note or a dataset the agent edits is
///                  its work, and stays. A file rewritten in place shares the link and cannot be put back: the edit tools
///                  are refused on papers for that (Policy.claudeSettings).
/// What the person did meanwhile is left alone: a row deleted, or moved, is not put back, nor the ink of a row that went.
public final class LibraryKeep: @unchecked Sendable {
    static let limit = 20_000
    static let farMax: Int64 = 20 * 1024 * 1024
    static let papersTypes: Set<String> = ["pdf", "image"]

    public struct PutBack: Sendable, Equatable {
        public var name: String
        public var file: String
        /// deleted | changed
        public var how: String
    }

    struct Entry {
        var id: String?
        var name: String
        var of: String?
        var bytes: Bool
        var file: String
        var copy: String
        var how: String // link | copy
        var size: Int64
        var mtime: timespec
        var ino: UInt64
    }

    let dir: String
    let host: BuildHost
    var entries: [Entry] = []
    /// The pdf and picture files outside the kept folders (the edit tools' rules).
    public private(set) var papers: [String] = []
    public var count: Int { entries.count }

    init(dir: String, host: BuildHost) { self.dir = dir; self.host = host }

    /// The library's files and their ink, kept in `dir` (emptied first; removed by `restore`). `kept`: the folders whose
    /// files are all saved copies (Policy).
    public static func keep(host: BuildHost, dir: String, kept: [String]) async throws -> LibraryKeep {
        FS.remove(dir)
        try FS.mkdirs(dir, mode: 0o700)
        let keeping = LibraryKeep(dir: dir, host: host)
        for row in await host.libraryRows() {
            guard let p = row.path, NodePath.isAbsolute(p) else { continue }
            let saved = kept.contains { NodePath.inside($0, p) }
            keeping.keep(p, id: row.id, name: row.name, of: nil, bytes: saved || papersTypes.contains(row.type))
            if papersTypes.contains(row.type) && !saved { keeping.papers.append(p) }
        }
        var ink: [String] = []
        walk(NodePath.join(host.dataRoot, "annotations"), &ink, limit)
        let uuid = try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: .caseInsensitive)
        for file in ink {
            let stem = NodePath.basename(file, NodePath.extname(file))
            let isId = uuid.firstMatch(in: stem, range: NSRange(stem.startIndex..., in: stem)) != nil
            keeping.keep(file, id: nil, name: "highlights and notes", of: isId ? stem : nil, bytes: false)
        }
        return keeping
    }

    static func walk(_ dir: String, _ out: inout [String], _ limit: Int) {
        guard let names = FS.list(dir) else { return }
        for name in names {
            if out.count >= limit { return }
            let file = NodePath.join(dir, name)
            var st = stat()
            guard lstat(file, &st) == 0 else { continue }
            let kind = st.st_mode & S_IFMT
            if kind == S_IFDIR { walk(file, &out, limit) } else if kind == S_IFREG { out.append(file) }
        }
    }

    func keep(_ file: String, id: String?, name: String, of: String?, bytes: Bool) {
        if entries.count >= LibraryKeep.limit { return }
        var st = stat()
        guard stat(file, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else { return }
        let copy = NodePath.join(dir, String(entries.count))
        let how: String
        if link(file, copy) == 0 { how = "link" }
        else if Int64(st.st_size) <= LibraryKeep.farMax, (try? FileManager.default.copyItem(atPath: file, toPath: copy)) != nil { how = "copy" }
        else { return }
        entries.append(Entry(id: id, name: name, of: of, bytes: bytes, file: file, copy: copy, how: how, size: Int64(st.st_size), mtime: st.st_mtimespec, ino: UInt64(st.st_ino)))
    }

    /// The kept file back at `file`, in place of whatever is there, whole or not at all.
    static func putBack(_ entry: Entry) throws {
        try FS.mkdirs(NodePath.dirname(entry.file))
        let temporary = "\(entry.file).engelbart-\(getpid()).tmp"
        FS.remove(temporary)
        if entry.how == "link" {
            if Darwin.link(entry.copy, temporary) != 0 { try FileManager.default.copyItem(atPath: entry.copy, toPath: temporary) }
        } else {
            try FileManager.default.copyItem(atPath: entry.copy, toPath: temporary)
        }
        try FS.rename(temporary, entry.file)
    }

    static func sameBytes(_ a: String, _ b: String) -> Bool {
        guard let x = FileManager.default.contents(atPath: a), let y = FileManager.default.contents(atPath: b) else { return false }
        return x == y
    }

    /// → what was put back: [{ name, file, how: deleted | changed }]
    public func restore() async -> [PutBack] {
        var back: [PutBack] = []
        defer { FS.remove(dir) }
        let rows = Dictionary(await host.libraryRows().map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for entry in entries {
            if let id = entry.id, rows[id] == nil || rows[id]?.path != entry.file { continue }
            if let of = entry.of, rows[of] == nil { continue }
            var st = stat()
            let exists = lstat(entry.file, &st) == 0
            do {
                if !exists {
                    try LibraryKeep.putBack(entry)
                    back.append(PutBack(name: entry.name, file: entry.file, how: "deleted"))
                    continue
                }
                let kind = st.st_mode & S_IFMT
                if !entry.bytes || kind == S_IFDIR { continue }
                // A link sees what was written into the file it shares, so only a file put in its place can be told apart.
                let isFile = kind == S_IFREG
                let replaced = !isFile || UInt64(st.st_ino) != entry.ino
                let sameTime = st.st_mtimespec.tv_sec == entry.mtime.tv_sec && st.st_mtimespec.tv_nsec == entry.mtime.tv_nsec
                let changed = entry.how == "link" ? replaced : (replaced || Int64(st.st_size) != entry.size || !sameTime)
                if changed && !(isFile && LibraryKeep.sameBytes(entry.file, entry.copy)) {
                    try LibraryKeep.putBack(entry)
                    back.append(PutBack(name: entry.name, file: entry.file, how: "changed"))
                }
            } catch { /* left as it is: the next turn keeps what is there then */ }
        }
        return back
    }
}
