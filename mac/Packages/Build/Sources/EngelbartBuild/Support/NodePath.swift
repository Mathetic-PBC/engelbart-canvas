import Foundation

/// Node's `path` (posix) for the few operations the Build code reads paths with. Kept as strings, as the Electron code
/// does, so `path.relative`, `path.resolve` and friends give the same answers (a URL would normalise differently).
enum NodePath {
    static let sep = "/"

    static func isAbsolute(_ p: String) -> Bool { p.hasPrefix("/") }

    /// `path.normalize` for posix paths.
    static func normalize(_ p: String) -> String {
        if p.isEmpty { return "." }
        let absolute = p.hasPrefix("/")
        let trailing = p.hasSuffix("/")
        var out: [String] = []
        for part in p.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." {
                if let last = out.last, last != ".." { out.removeLast() }
                else if !absolute { out.append("..") }
                continue
            }
            out.append(String(part))
        }
        var joined = out.joined(separator: "/")
        if absolute { joined = "/" + joined }
        if joined.isEmpty { joined = absolute ? "/" : "." }
        if trailing && joined != "/" { joined += "/" }
        return joined
    }

    static func join(_ parts: String...) -> String { join(parts) }
    static func join(_ parts: [String]) -> String {
        let kept = parts.filter { !$0.isEmpty }
        if kept.isEmpty { return "." }
        return normalize(kept.joined(separator: "/"))
    }

    /// `path.resolve(...)`: right to left until an absolute path, relative to the current directory.
    static func resolve(_ parts: String...) -> String { resolve(parts) }
    static func resolve(_ parts: [String]) -> String {
        var resolved = ""
        for part in parts.reversed() where !part.isEmpty {
            resolved = resolved.isEmpty ? part : part + "/" + resolved
            if part.hasPrefix("/") { break }
        }
        if !resolved.hasPrefix("/") { resolved = FileManager.default.currentDirectoryPath + "/" + resolved }
        var n = normalize(resolved)
        if n.count > 1 && n.hasSuffix("/") { n.removeLast() }
        return n
    }

    /// `path.relative(from, to)`.
    static func relative(_ from: String, _ to: String) -> String {
        let a = resolve(from), b = resolve(to)
        if a == b { return "" }
        let fa = a.split(separator: "/").map(String.init), fb = b.split(separator: "/").map(String.init)
        var i = 0
        while i < fa.count && i < fb.count && fa[i] == fb[i] { i += 1 }
        let up = Array(repeating: "..", count: fa.count - i)
        return (up + fb[i...]).joined(separator: "/")
    }

    static func dirname(_ p: String) -> String {
        if p.isEmpty { return "." }
        var s = p
        while s.count > 1 && s.hasSuffix("/") { s.removeLast() }
        guard let slash = s.lastIndex(of: "/") else { return "." }
        if slash == s.startIndex { return "/" }
        return String(s[..<slash])
    }

    static func basename(_ p: String, _ ext: String? = nil) -> String {
        var s = p
        while s.count > 1 && s.hasSuffix("/") { s.removeLast() }
        let base = s.split(separator: "/").last.map(String.init) ?? s
        if let ext, !ext.isEmpty, base.hasSuffix(ext), base != ext { return String(base.dropLast(ext.count)) }
        return base
    }

    static func extname(_ p: String) -> String {
        let base = basename(p)
        guard let dot = base.lastIndex(of: "."), dot != base.startIndex else { return "" }
        return String(base[dot...])
    }

    /// `fs.realpathSync`, else the path resolved (the Electron code's `canonical`).
    static func real(_ p: String) -> String {
        guard let r = realpath(p, nil) else { return resolve(p) }
        defer { free(r) }
        return String(cString: r)
    }

    static func realOrNil(_ p: String) -> String? {
        guard let r = realpath(p, nil) else { return nil }
        defer { free(r) }
        return String(cString: r)
    }

    /// `target === base || target.startsWith(base + sep)`.
    static func inside(_ base: String, _ target: String) -> Bool { target == base || target.hasPrefix(base + "/") }
}

/// The few `fs` calls the code makes, as the Electron code reads them.
enum FS {
    static var fm: FileManager { FileManager.default }

    static func exists(_ p: String) -> Bool {
        var st = stat()
        return stat(p, &st) == 0
    }

    /// lstat: true for a dangling link too.
    static func present(_ p: String) -> Bool {
        var st = stat()
        return lstat(p, &st) == 0
    }

    static func isDirectory(_ p: String) -> Bool {
        var st = stat()
        return stat(p, &st) == 0 && (st.st_mode & S_IFMT) == S_IFDIR
    }

    static func isFile(_ p: String) -> Bool {
        var st = stat()
        return stat(p, &st) == 0 && (st.st_mode & S_IFMT) == S_IFREG
    }

    static func isSymlink(_ p: String) -> Bool {
        var st = stat()
        return lstat(p, &st) == 0 && (st.st_mode & S_IFMT) == S_IFLNK
    }

    static func readText(_ p: String) -> String? {
        guard let data = fm.contents(atPath: p) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    static func list(_ p: String) -> [String]? { try? fm.contentsOfDirectory(atPath: p) }

    static func mkdirs(_ p: String, mode: Int = 0o755) throws {
        try fm.createDirectory(atPath: p, withIntermediateDirectories: true, attributes: [.posixPermissions: mode])
    }

    static func write(_ p: String, _ text: String, mode: Int? = nil) throws {
        try write(p, Data(text.utf8), mode: mode)
    }

    static func write(_ p: String, _ data: Data, mode: Int? = nil) throws {
        let ok = fm.createFile(atPath: p, contents: data, attributes: mode.map { [.posixPermissions: $0] })
        if !ok { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "\(p) could not be written"]) }
        if let mode { chmod(p, mode_t(mode)) }
    }

    static func remove(_ p: String) { try? fm.removeItem(atPath: p) }

    static func unlink(_ p: String) { Darwin.unlink(p) }

    static func rename(_ a: String, _ b: String) throws {
        if Darwin.rename(a, b) != 0 { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: String(cString: strerror(errno))]) }
    }

    /// Whether a folder holds nothing but .DS_Store (manager.cjs emptyFolder).
    static func emptyFolder(_ p: String) -> Bool {
        guard let names = list(p) else { return false }
        return names.allSatisfy { $0 == ".DS_Store" }
    }
}
