import Foundation
import EngelbartCore
import zlib

// src/main/overleaf/copy.cjs (MATH-65, Overleaf part 1, 2026-10-07): a copy of a whole Overleaf project on disk, for @bart
// to read the files that are not open in the editor. https://www.overleaf.com/project/<id>/download/zip is downloaded with
// the Stage's own session (the app hands in an HTTPClient over the Stage's WKWebsiteDataStore cookies), so the sign-in is
// the one the person made in the Stage and no cookie leaves it. Unpacked to <dataRoot>/.overleaf/<projectId>/, swapped in
// whole once unpacked; what it holds is written beside it, <dataRoot>/.overleaf/<projectId>.json: { projectId, fetchedAt,
// files, skipped: [{ path, bytes, why }] }. Refreshed before an @bart turn when over MAX_AGE_MS old (ensure); one download
// at a time per project (a turn that comes while one runs waits on it). A binary file over 20 MB is skipped; text files
// are always kept. Nothing here ever writes to Overleaf.

public struct OverleafSkipped: Equatable, Sendable {
    public var path: String
    public var bytes: Int
    public var why: String

    public var json: JSONValue { ["path": .string(path), "bytes": .number(Double(bytes)), "why": .string(why)] }
}

/// The copy's info, or why there is none (`error`); `pending` when a turn did not wait for a download.
public struct OverleafCopyInfo: Equatable, Sendable {
    public var projectId: String
    public var folder: String?
    public var fetchedAt: Double?
    public var files: Int = 0
    public var skipped: [OverleafSkipped] = []
    public var fresh: Bool = false
    public var error: String?
    public var pending: Bool = false
}

public struct OverleafZipError: Error, LocalizedError, Equatable {
    public let message: String
    public var errorDescription: String? { message }
}

public enum OverleafCopy {
    public static let maxAgeMs: Double = 60_000
    public static let maxBinaryBytes = 20 * 1024 * 1024
    public static let maxZipBytes = 500 * 1024 * 1024
    static let maxFileBytes = 200 * 1024 * 1024
    static let maxEntries = 20_000
    public static let downloadTimeout: TimeInterval = 120
    public static let base = "https://www.overleaf.com"
    /// What is read as text, by extension; a file with none (latexmkrc, Makefile) is text too. Anything else is binary.
    static let textExt: Set<String> = ["tex", "ltx", "latex", "bib", "bbl", "bst", "bbx", "cbx", "cls", "sty", "clo", "cfg", "def", "dtx", "ins", "fd",
        "txt", "md", "markdown", "rnw", "rtex", "rmd", "csv", "tsv", "dat", "json", "yaml", "yml", "xml", "svg", "tikz", "pgf", "pgf-plot",
        "lua", "py", "r", "m", "sh", "pl", "gnuplot", "gp", "ist", "gls", "glo", "idx", "ind", "nlo", "nls", "lof", "lot", "toc", "aux", "log",
        "html", "htm", "css", "js", "mk", "tikzstyles", "asy", "mp", "lbx", "gitignore", "latexmkrc"]
    static let idRE = re("^[0-9a-f]{24}$")

    public static func overleafRoot(_ dataRoot: String) -> String { join(dataRoot, ".overleaf") }
    public static func copyDir(_ dataRoot: String, _ projectId: String) -> String { join(overleafRoot(dataRoot), projectId) }
    public static func infoFile(_ dataRoot: String, _ projectId: String) -> String { join(overleafRoot(dataRoot), "\(projectId).json") }
    public static func isProjectId(_ id: String) -> Bool { idRE.test(id) }

    public static func isText(_ name: String) -> Bool {
        let base = (name as NSString).lastPathComponent
        guard let dot = base.lastIndex(of: "."), dot != base.startIndex else {
            return !base.hasPrefix(".") || textExt.contains(String(base.dropFirst()).lowercased())
        }
        return textExt.contains(String(base[base.index(after: dot)...]).lowercased())
    }

    /// A name in the zip as a safe relative path ('a/b.tex'), or '' for a folder, an absolute path, or one that leaves.
    public static func safeName(_ name: String) -> String {
        if name.isEmpty || name.contains("\0") || name.contains("\\") || name.hasSuffix("/") { return "" }
        if name.hasPrefix("/") || re("^[a-z]:", .caseInsensitive).test(name) { return "" }
        let parts = name.split(separator: "/", omittingEmptySubsequences: true).map(String.init).filter { $0 != "." }
        if parts.isEmpty || parts.contains("..") { return "" }
        return parts.joined(separator: "/")
    }

    // MARK: reading a zip

    private static func u16(_ b: [UInt8], _ at: Int) -> Int { Int(b[at]) | Int(b[at + 1]) << 8 }
    private static func u32(_ b: [UInt8], _ at: Int) -> UInt32 { UInt32(b[at]) | UInt32(b[at + 1]) << 8 | UInt32(b[at + 2]) << 16 | UInt32(b[at + 3]) << 24 }

    static func crc(_ data: [UInt8]) -> UInt32 {
        data.withUnsafeBufferPointer { UInt32(crc32(0, $0.baseAddress, uInt($0.count))) }
    }

    /// Raw deflate (zlib windowBits -15), at most `expected` bytes out.
    static func inflateRaw(_ input: ArraySlice<UInt8>, expected: Int) throws -> [UInt8] {
        var stream = z_stream()
        guard inflateInit2_(&stream, -15, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { throw OverleafZipError(message: "The project zip is damaged") }
        defer { inflateEnd(&stream) }
        var output = [UInt8](repeating: 0, count: max(1, expected))
        var source = Array(input)
        var status: Int32 = Z_OK
        try source.withUnsafeMutableBufferPointer { src in
            try output.withUnsafeMutableBufferPointer { dst in
                stream.next_in = src.baseAddress
                stream.avail_in = uInt(src.count)
                stream.next_out = dst.baseAddress
                stream.avail_out = uInt(dst.count)
                status = inflate(&stream, Z_FINISH)
                if status != Z_STREAM_END && !(status == Z_BUF_ERROR && stream.avail_out == 0) && status != Z_OK {
                    throw OverleafZipError(message: "The project zip is damaged")
                }
            }
        }
        return Array(output.prefix(Int(stream.total_out)))
    }

    /// The files of a zip → (files, skipped). Stored and deflated entries; folders, links, encrypted entries and names
    /// that would leave the copy are passed over; a binary file over `maxBinaryBytes` is skipped before it is inflated.
    /// Throws on what is no zip, or one this cannot read (ZIP64).
    public static func readZip(_ data: Data, maxBinaryBytes: Int = maxBinaryBytes) throws -> (files: [(name: String, data: Data)], skipped: [OverleafSkipped]) {
        let buf = [UInt8](data)
        var eocd = -1
        if buf.count >= 22 {
            var i = buf.count - 22
            let stop = max(0, buf.count - 22 - 65535)
            while i >= stop { if u32(buf, i) == 0x06054b50 { eocd = i; break }; i -= 1 }
        }
        if eocd < 0 { throw OverleafZipError(message: "Overleaf did not send a zip") }
        let count = u16(buf, eocd + 10), size = u32(buf, eocd + 12), start = u32(buf, eocd + 16)
        if count == 0xffff || size == 0xffffffff || start == 0xffffffff { throw OverleafZipError(message: "The project zip is too large to read") }
        if count > maxEntries { throw OverleafZipError(message: "The project has too many files") }
        if Int(start) + Int(size) > eocd { throw OverleafZipError(message: "The project zip is damaged") }
        var files: [(String, Data)] = [], skipped: [OverleafSkipped] = []
        var at = Int(start)
        for _ in 0..<count {
            if at + 46 > buf.count || u32(buf, at) != 0x02014b50 { throw OverleafZipError(message: "The project zip is damaged") }
            let flags = u16(buf, at + 8), method = u16(buf, at + 10), crcValue = u32(buf, at + 16)
            let packed = Int(u32(buf, at + 20)), bytes = Int(u32(buf, at + 24))
            let nameLength = u16(buf, at + 28), extraLength = u16(buf, at + 30), commentLength = u16(buf, at + 32)
            let mode = (u32(buf, at + 38) >> 16) & 0o170000, local = Int(u32(buf, at + 42))
            guard at + 46 + nameLength <= buf.count else { throw OverleafZipError(message: "The project zip is damaged") }
            let raw = String(decoding: buf[(at + 46)..<(at + 46 + nameLength)], as: UTF8.self)
            at += 46 + nameLength + extraLength + commentLength
            let name = safeName(raw)
            if name.isEmpty || mode == 0o120000 || mode == 0o040000 { continue }
            if flags & 1 != 0 { skipped.append(OverleafSkipped(path: name, bytes: bytes, why: "encrypted")); continue }
            if !isText(name) && bytes > maxBinaryBytes { skipped.append(OverleafSkipped(path: name, bytes: bytes, why: "binary over the size limit")); continue }
            if bytes > maxFileBytes { skipped.append(OverleafSkipped(path: name, bytes: bytes, why: "too large")); continue }
            if local + 30 > buf.count || u32(buf, local) != 0x04034b50 { throw OverleafZipError(message: "The project zip is damaged") }
            let from = local + 30 + u16(buf, local + 26) + u16(buf, local + 28)
            guard from <= buf.count else { throw OverleafZipError(message: "The project zip is damaged") }
            let body = buf[from..<min(buf.count, from + packed)]
            let out: [UInt8]
            if method == 0 { out = Array(body) }
            else if method == 8 { out = try inflateRaw(body, expected: bytes) }
            else { skipped.append(OverleafSkipped(path: name, bytes: bytes, why: "unknown compression")); continue }
            if out.count != bytes || crc(out) != crcValue { throw OverleafZipError(message: "The project zip is damaged") }
            files.append((name, Data(out)))
        }
        return (files.map { (name: $0.0, data: $0.1) }, skipped)
    }

    // MARK: on disk

    public static func readInfo(_ dataRoot: String, _ projectId: String) -> OverleafCopyInfo? {
        guard let info = FileOps.readJSON(infoFile(dataRoot, projectId)), let fetchedAt = info["fetchedAt"]?.double, fetchedAt.isFinite,
              FileOps.isDirectory(copyDir(dataRoot, projectId)) else { return nil }
        let skipped = (info["skipped"]?.array ?? []).map { OverleafSkipped(path: $0["path"]?.stringish ?? "", bytes: $0["bytes"]?.int ?? 0, why: $0["why"]?.stringish ?? "") }
        return OverleafCopyInfo(projectId: projectId, folder: copyDir(dataRoot, projectId), fetchedAt: fetchedAt, files: info["files"]?.int ?? 0, skipped: skipped)
    }

    /// The files written to a new folder beside the copy, then swapped in for it, the old one removed.
    static func writeCopy(_ dataRoot: String, _ projectId: String, _ files: [(name: String, data: Data)]) throws {
        let root = overleafRoot(dataRoot)
        FileOps.mkdir(root, mode: 0o700)
        let incoming = join(root, ".\(projectId).incoming-\(UUID().uuidString.lowercased())")
        do {
            for file in files {
                let target = join(incoming, file.name)
                FileOps.mkdir((target as NSString).deletingLastPathComponent)
                try file.data.write(to: URL(fileURLWithPath: target))
            }
            FileOps.mkdir(incoming) // an empty project is an empty folder
            let dir = copyDir(dataRoot, projectId)
            let old = join(root, ".\(projectId).old-\(UUID().uuidString.lowercased())")
            var moved = false
            if FileOps.exists(dir) { try FileManager.default.moveItem(atPath: dir, toPath: old); moved = true }
            try FileManager.default.moveItem(atPath: incoming, toPath: dir)
            if moved { FileOps.remove(old) }
        } catch {
            FileOps.remove(incoming)
            throw error
        }
    }
}

/// The copies, one download per project at a time (createOverleafCopies). `http` is the Stage's session's client.
@MainActor
public final class OverleafCopies {
    let http: HTTPClient
    let now: NowMs
    let base: String
    let maxAgeMs: Double
    let maxBinaryBytes: Int
    let maxZipBytes: Int
    let timeout: TimeInterval
    private var running: [String: Task<OverleafCopyInfo, Never>] = [:]

    public init(http: HTTPClient, now: @escaping NowMs = systemNow, base: String = OverleafCopy.base, maxAgeMs: Double = OverleafCopy.maxAgeMs,
                maxBinaryBytes: Int = OverleafCopy.maxBinaryBytes, maxZipBytes: Int = OverleafCopy.maxZipBytes, timeout: TimeInterval = OverleafCopy.downloadTimeout) {
        self.http = http; self.now = now; self.base = base; self.maxAgeMs = maxAgeMs; self.maxBinaryBytes = maxBinaryBytes
        self.maxZipBytes = maxZipBytes; self.timeout = timeout
    }

    private func download(_ dataRoot: String, _ projectId: String) async throws -> OverleafCopyInfo {
        guard let url = URL(string: "\(base)/project/\(projectId)/download/zip") else { throw OverleafZipError(message: "Not an Overleaf project id") }
        let response: HTTPResponse
        do { response = try await http.send(HTTPRequest(url: url, timeout: timeout, maxBytes: maxZipBytes)) } catch let e as HTTPError where e == .tooLarge {
            throw OverleafZipError(message: "The project is too large to copy")
        }
        guard response.ok else { throw OverleafZipError(message: "Overleaf answered \(response.status) for the project's zip") }
        let body = response.body
        // signed out, Overleaf sends its sign-in page (200, html) in place of the zip
        let magic: [UInt8] = body.count == 22 ? [0x50, 0x4b, 0x05, 0x06] : [0x50, 0x4b, 0x03, 0x04]
        if body.count < 4 || Array(body.prefix(4)) != magic { throw OverleafZipError(message: "Overleaf did not send the project: is the Stage signed in to overleaf.com?") }
        let limit = maxBinaryBytes
        let fetchedAt = now()
        let skipped: [OverleafSkipped] = try await Task.detached {
            let (files, skipped) = try OverleafCopy.readZip(body, maxBinaryBytes: limit)
            try OverleafCopy.writeCopy(dataRoot, projectId, files)
            let info: JSONValue = ["projectId": .string(projectId), "fetchedAt": .number(fetchedAt), "files": .number(Double(files.count)), "skipped": .array(skipped.map(\.json))]
            try FileOps.write(JSONText.stringify(info, indent: 1) + "\n", to: OverleafCopy.infoFile(dataRoot, projectId))
            return skipped
        }.value
        _ = skipped
        var info = OverleafCopy.readInfo(dataRoot, projectId) ?? OverleafCopyInfo(projectId: projectId)
        info.fresh = true
        return info
    }

    /// A download now, or the one already running for this project. Never throws: a failure → { error, …old info }.
    public func refresh(_ dataRoot: String, _ projectId: String) async -> OverleafCopyInfo {
        guard OverleafCopy.isProjectId(projectId) else { return OverleafCopyInfo(projectId: projectId, error: "Not an Overleaf project id") }
        let key = OverleafCopy.copyDir(dataRoot, projectId)
        if let run = running[key] { return await run.value }
        let task = Task { @MainActor () -> OverleafCopyInfo in
            do { return try await self.download(dataRoot, projectId) } catch {
                var info = OverleafCopy.readInfo(dataRoot, projectId) ?? OverleafCopyInfo(projectId: projectId)
                info.error = jsSlice(error.localizedDescription, 300)
                return info
            }
        }
        running[key] = task
        let out = await task.value
        running[key] = nil
        return out
    }

    /// The copy as it is when at most `maxAge` old, else refreshed (joined to a download already running).
    public func ensure(_ dataRoot: String, _ projectId: String, maxAge: Double? = nil) async -> OverleafCopyInfo {
        guard OverleafCopy.isProjectId(projectId) else { return OverleafCopyInfo(projectId: projectId, error: "Not an Overleaf project id") }
        if var held = OverleafCopy.readInfo(dataRoot, projectId), let at = held.fetchedAt, now() - at <= (maxAge ?? maxAgeMs) {
            held.fresh = true
            return held
        }
        return await refresh(dataRoot, projectId)
    }

    public func info(_ dataRoot: String, _ projectId: String) -> OverleafCopyInfo? { OverleafCopy.readInfo(dataRoot, projectId) }
    public func inFlight(_ dataRoot: String, _ projectId: String) -> Bool { running[OverleafCopy.copyDir(dataRoot, projectId)] != nil }
}
