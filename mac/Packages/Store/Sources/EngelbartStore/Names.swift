import Foundation
import EngelbartCore

/// home.cjs's name rules and its JSON file helpers.
public enum Names {
    static let maxName = 120

    /// A display name → a filesystem-safe directory or file stem. Keeps spaces and unicode; slashes become hyphens; drops
    /// colons, control characters and leading dots; at most 120 characters; "Untitled" when nothing is left.
    public static func sanitizeName(_ name: String?) -> String {
        var value = name ?? ""
        value = String(value.unicodeScalars.filter { !($0.value < 0x20 || $0.value == 0x7f) }.map(Character.init))
        value = value.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: "\\", with: "-").replacingOccurrences(of: ":", with: "")
        value = value.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        while value.hasPrefix(".") { value.removeFirst() }
        value = value.trimmingCharacters(in: .whitespaces)
        if value.count > maxName { value = String(value.prefix(maxName)).trimmingCharacters(in: .whitespaces) }
        return value.isEmpty ? "Untitled" : value
    }

    /// A directory name the way the create screen shows it after "./": lower-case, dashes, at most 48.
    public static func slugify(_ value: String?) -> String {
        let lower = (value ?? "").lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        var out = lower.replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
        out = out.replacingOccurrences(of: "^-+|-+$", with: "", options: .regularExpression)
        return String(out.prefix(48))
    }

    /// 'Goal', then 'Goal 2', 'Goal 3' … until no entry with that name (+ext) exists in `dir`.
    public static func uniqueName(_ dir: String, _ base: String, ext: String = "") -> String {
        var candidate = base
        var counter = 2
        while FileManager.default.fileExists(atPath: (dir as NSString).appendingPathComponent(candidate + ext)) {
            candidate = "\(base) \(counter)"
            counter += 1
        }
        return candidate
    }
}

/// JSON files as the Electron store writes them: `JSON.stringify(value, null, 2) + '\n'`, through a temporary file, 0600.
public enum JSONFiles {
    public static func read(_ path: String) -> JSONValue? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return try? JSONValue.parse(data)
    }

    public static func write(_ path: String, _ value: JSONValue) throws {
        try Files.writeAtomically(value.text(pretty: true) + "\n", to: URL(fileURLWithPath: path), mode: 0o600)
    }

    /// Text written whole or not at all, 0600 (projects.cjs writeTextAtomic).
    public static func writeText(_ path: String, _ text: String) throws {
        try Files.writeAtomically(text, to: URL(fileURLWithPath: path), mode: 0o600)
    }

    public static func writeData(_ path: String, _ data: Data) throws {
        try Files.writeAtomically(data, to: URL(fileURLWithPath: path), mode: 0o600)
    }

    /// mkdir -p with mode 0700 (home.cjs DIR_MODE).
    public static func makeDir(_ path: String) throws {
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }

    /// mkdir that fails when the directory exists (fs.mkdirSync without recursive).
    public static func makeNewDir(_ path: String) throws {
        if mkdir(path, 0o700) != 0 { throw StoreError("EEXIST: could not make \(path) (\(String(cString: strerror(errno))))") }
    }
}

extension JSONValue {
    var isPlainObject: Bool { if case .object = self { return true }; return false }
}

/// Small path helpers with Node's semantics.
enum Paths {
    static func join(_ parts: String...) -> String { join(parts) }
    static func join(_ parts: [String]) -> String {
        var out = ""
        for part in parts where !part.isEmpty { out = out.isEmpty ? part : (out as NSString).appendingPathComponent(part) }
        return normalize(out)
    }
    /// path.resolve: absolute, `.`/`..` folded, no trailing slash.
    static func resolve(_ path: String) -> String {
        let absolute = path.hasPrefix("/") ? path : (FileManager.default.currentDirectoryPath as NSString).appendingPathComponent(path)
        return normalize(absolute)
    }
    static func normalize(_ path: String) -> String {
        let absolute = path.hasPrefix("/")
        var parts: [String] = []
        for part in path.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." { if !parts.isEmpty && parts.last != ".." { parts.removeLast() } else if !absolute { parts.append("..") }; continue }
            parts.append(String(part))
        }
        let joined = parts.joined(separator: "/")
        return absolute ? "/" + joined : (joined.isEmpty ? "." : joined)
    }
    static func basename(_ path: String) -> String { (path as NSString).lastPathComponent }
    static func dirname(_ path: String) -> String { (path as NSString).deletingLastPathComponent }
    /// path.extname: ".pdf" (with the dot), "" for none or a dot file.
    static func extname(_ path: String) -> String {
        let base = basename(path)
        guard let dot = base.lastIndex(of: "."), dot != base.startIndex else { return "" }
        return String(base[dot...])
    }
    /// fs.realpathSync: the path with every symlink resolved; throws when nothing is there.
    static func real(_ path: String) throws -> String {
        guard let resolved = realpath(path, nil) else {
            let code = errno
            throw POSIXFailure(code: code, path: path)
        }
        defer { free(resolved) }
        return String(cString: resolved)
    }
    static func realOrNil(_ path: String) -> String? { try? real(path) }
    static func realOrResolved(_ path: String) -> String { realOrNil(path) ?? resolve(path) }
    /// `file === dir || file.startsWith(dir + sep)`.
    static func inside(_ file: String, _ dir: String) -> Bool { file == dir || file.hasPrefix(dir + "/") }
    static func isDirectory(_ path: String) -> Bool { var d: ObjCBool = false; return FileManager.default.fileExists(atPath: path, isDirectory: &d) && d.boolValue }
    static func isFile(_ path: String) -> Bool { var d: ObjCBool = false; return FileManager.default.fileExists(atPath: path, isDirectory: &d) && !d.boolValue }
    static func exists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }
    static func mtime(_ path: String) -> Date? { (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date }
    static func size(_ path: String) -> Int? { ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.intValue }
    /// path.relative(from, to)
    static func relative(_ from: String, _ to: String) -> String {
        let a = resolve(from).split(separator: "/").map(String.init), b = resolve(to).split(separator: "/").map(String.init)
        var i = 0
        while i < a.count && i < b.count && a[i] == b[i] { i += 1 }
        return (Array(repeating: "..", count: a.count - i) + b[i...]).joined(separator: "/")
    }
    /// The URL `pathToFileURL(path).href` gives.
    static func fileURL(_ path: String) -> String { URL(fileURLWithPath: path).absoluteString }
    /// `fileURLToPath`.
    static func fromFileURL(_ value: String) -> String? {
        guard let url = URL(string: value), url.isFileURL else { return nil }
        return url.path
    }
    static func listDir(_ path: String) -> [String]? { try? FileManager.default.contentsOfDirectory(atPath: path) }
}

/// A failed stat/read, with its errno (ENOENT, EPERM, EACCES) as Node's `error.code`.
struct POSIXFailure: Error, LocalizedError {
    var code: Int32
    var path: String
    var name: String {
        switch code { case ENOENT: return "ENOENT"; case EPERM: return "EPERM"; case EACCES: return "EACCES"; default: return "E\(code)" }
    }
    var errorDescription: String? { "\(name): \(String(cString: strerror(code))), '\(path)'" }
}
