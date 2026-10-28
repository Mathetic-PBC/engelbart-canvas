import Foundation
import CryptoKit
import EngelbartCore

// What the Stage shows for a path (src/main/stage/files.cjs, 2026-09-23, Claude Design "Add - Mention Stage.dc.html"):
// what it is and what is needed to draw it. A pdf and a picture come as bytes, text as text, an html file as its file:
// address for the page view. Two formats only macOS reads are converted with the tools it ships, once per version of
// the file, into <data root>/.cache/stage: a heic picture (sips → jpeg) and a word-processor document (textutil → html,
// shown as a page). The path is already resolved and inside the home folder (the host's resolveTypedPath).

public enum StageFiles {
    public static let maxPDFBytes = 200 * 1024 * 1024 // the library's limit
    public static let maxImageBytes = 50 * 1024 * 1024
    public static let maxTextBytes = 2 * 1024 * 1024
    public static let maxTextChars = 500_000
    public static let convertTimeout: TimeInterval = 30
    public static let imageTypes = [".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"]
    static let heic: Set<String> = [".heic", ".heif"]
    static let documents: Set<String> = [".docx", ".doc", ".rtf", ".odt"]

    // A file macOS keeps from Engelbart (2026-10-02): its privacy settings answer a stat or a read with EPERM, and a mode
    // that shuts Engelbart out answers EACCES. Said as that, not as a missing file.
    public static let blocked = "macOS blocked Engelbart from reading this file. Allow access in System Settings → Privacy & Security → Files and Folders."

    public struct Failure: Error, LocalizedError, Equatable {
        public let message: String
        public let code: Int32?
        public init(_ message: String, code: Int32? = nil) { self.message = message; self.code = code }
        public var errorDescription: String? { message }
    }

    /// A failed stat or read of a person's file as they should hear it: nothing there, or blocked; anything else as it came.
    public static func readFailure(code: Int32, message: String) -> Failure {
        if code == ENOENT { return Failure("Nothing is at that path", code: code) }
        if code == EPERM || code == EACCES { return Failure(blocked, code: code) }
        return Failure(message, code: code)
    }

    /// The file's stat, as readFailure's errors.
    static func statOf(_ file: String) throws -> stat {
        var st = stat()
        if stat(file, &st) != 0 { let e = errno; throw readFailure(code: e, message: String(cString: strerror(e))) }
        return st
    }

    /// The file's bytes, as readFailure's errors.
    public static func readBytes(_ file: String) throws -> Data {
        let fd = open(file, O_RDONLY)
        if fd < 0 { let e = errno; throw readFailure(code: e, message: String(cString: strerror(e))) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do { return try handle.readToEnd() ?? Data() } catch { throw readFailure(code: EIO, message: error.localizedDescription) }
    }

    /// One name per version of a file: its real path, when it last changed, how big it is.
    public static func cacheKey(_ file: String, mtimeMs: Double, size: Int64) -> String {
        let text = "\(file)\n\(Boxes.fmt(mtimeMs))\n\(size)"
        return SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined().prefix(32).description
    }

    static func mtimeMs(_ st: stat) -> Double { Double(st.st_mtimespec.tv_sec) * 1000 + Double(st.st_mtimespec.tv_nsec) / 1_000_000 }

    /// Text if its first 8 KB hold no NUL byte (the test git uses for binary), else nil.
    static func readText(_ file: String, size: Int64) throws -> (text: String, truncated: Bool)? {
        if size > Int64(maxTextBytes) { return nil }
        let data = try readBytes(file)
        if data.prefix(8192).contains(0) { return nil }
        let all = String(decoding: data, as: UTF8.self)
        let utf16 = all.utf16.count
        return (JSStr.slice(all, 0, maxTextChars), utf16 > maxTextChars)
    }

    public typealias RunTool = (_ tool: String, _ args: [String]) async throws -> Void

    public static let defaultRunTool: RunTool = { tool, args in
        try await ProcessRunner.check(tool, args, timeout: convertTimeout)
    }

    /// A converted copy in the cache, made now unless this version of the file was converted before.
    static func converted(cacheDir: URL, file: String, st: stat, ext: String, make: (String) async throws -> Void) async throws -> String {
        try FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let key = cacheKey(file, mtimeMs: mtimeMs(st), size: Int64(st.st_size))
        let out = cacheDir.appendingPathComponent("\(key)\(ext)").path
        if !FileManager.default.fileExists(atPath: out) {
            let temporary = cacheDir.appendingPathComponent("\(key).\(ProcessInfo.processInfo.processIdentifier).tmp\(ext)").path
            do {
                try await make(temporary)
                if FileManager.default.fileExists(atPath: out) { try? FileManager.default.removeItem(atPath: out) }
                try FileManager.default.moveItem(atPath: temporary, toPath: out)
            } catch {
                try? FileManager.default.removeItem(atPath: temporary)
                throw error
            }
        }
        return out
    }

    /// What is at `file`, for the Stage: folder, pdf, page, doc, md, table, image, text or unsupported.
    public static func readStageFile(_ file: String, cacheDir: URL, runTool: RunTool = defaultRunTool) async throws -> StageFile {
        let st = try statOf(file)
        let base = (file as NSString).lastPathComponent
        let rawExt = (file as NSString).pathExtension
        let ext = rawExt.isEmpty ? "" : "." + rawExt.lowercased()
        let isDir = (st.st_mode & S_IFMT) == S_IFDIR
        if isDir { return StageFile(kind: .folder, path: file, name: base) }
        guard (st.st_mode & S_IFMT) == S_IFREG else { throw Failure("That is not a file") }
        let size = Int64(st.st_size)
        let url = URL(fileURLWithPath: file).absoluteString
        if ext == ".pdf" {
            if size > Int64(maxPDFBytes) { throw Failure("The pdf is larger than 200 MB") }
            return StageFile(kind: .pdf, path: file, name: (base as NSString).deletingPathExtension, url: url, bytes: try readBytes(file))
        }
        if ext == ".html" || ext == ".htm" { return StageFile(kind: .page, path: file, name: base, url: url) }
        if let mime = imageTypes[ext] {
            if size > Int64(maxImageBytes) { throw Failure("The picture is larger than 50 MB") }
            return StageFile(kind: .image, path: file, name: base, bytes: try readBytes(file), mime: mime)
        }
        if heic.contains(ext) {
            if size > Int64(maxImageBytes) { throw Failure("The picture is larger than 50 MB") }
            let jpeg = try await converted(cacheDir: cacheDir, file: file, st: st, ext: ".jpg") { out in try await runTool("/usr/bin/sips", ["-s", "format", "jpeg", file, "--out", out]) }
            return StageFile(kind: .image, path: file, name: base, bytes: try readBytes(jpeg), mime: "image/jpeg")
        }
        if documents.contains(ext) {
            let html = try await converted(cacheDir: cacheDir, file: file, st: st, ext: ".html") { out in try await runTool("/usr/bin/textutil", ["-convert", "html", "-output", out, file]) }
            return StageFile(kind: .doc, path: file, name: base, url: URL(fileURLWithPath: html).absoluteString)
        }
        guard let text = try readText(file, size: size) else { return StageFile(kind: .unsupported, path: file, name: base, ext: String(ext.dropFirst())) }
        if ext == ".md" || ext == ".markdown" { return StageFile(kind: .md, path: file, name: base, text: text.text, truncated: text.truncated) }
        if ext == ".csv" || ext == ".tsv" { return StageFile(kind: .table, path: file, name: base, text: text.text, truncated: text.truncated, delimiter: ext == ".tsv" ? "\t" : ",") }
        return StageFile(kind: .text, path: file, name: base, text: text.text, truncated: text.truncated, ext: String(ext.dropFirst()))
    }
}
