import Foundation

// Safari's sign-ins (2026-10-16, src/main/browser/safari-cookies.cjs). The file:
//   'cook', then the page count and each page's size, big-endian (u32);
//   each page: 00 00 01 00, its cookie count and each record's offset in the page, little-endian (u32);
//   each record, little-endian: its size, 4 unknown bytes, flags (0x1 secure, 0x4 HttpOnly), 4 unknown bytes, the offsets
//   (from the record's start) of its domain, name, path, value and comment, 4 zero bytes, then the expiry and the creation
//   time as doubles in Mac absolute time (seconds since 2001-01-01 UTC), then the NUL-terminated strings.
// No SameSite is kept on disk, so every cookie is written 'unspecified'. Where it is: the Safari container on current
// macOS, the old ~/Library/Cookies as the fallback; Safari 17+ profiles keep their own file by UUID. A profile's name is
// looked for in SafariTabs.db (NOT verified against a real Safari: "Profile 1", "Profile 2"… otherwise). All of it is
// behind Full Disk Access: a refused read is `needsDiskAccess`, never a crash or an empty copy.

public enum SafariCookies {
    public static let macEpochUnix: Double = 978_307_200
    public static let flagSecure: UInt32 = 0x1
    public static let flagHttpOnly: UInt32 = 0x4
    static let recordHeader = 56

    public struct Cookie: Equatable, Sendable {
        public var host, name, value, path: String
        public var expires: Int
        public var created: Int
        public var secure, httpOnly: Bool
    }
    public struct Parsed: Equatable, Sendable { public var cookies: [Cookie]; public var skipped: Int }

    /// Mac absolute time → Unix seconds; 0 or nonsense → 0.
    public static func macTimeToUnix(_ seconds: Double) -> Int {
        guard seconds.isFinite, seconds > 0 else { return 0 }
        return Int((seconds + macEpochUnix).rounded(.down))
    }

    static func u32be(_ d: [UInt8], _ at: Int) -> UInt32 { UInt32(d[at]) << 24 | UInt32(d[at + 1]) << 16 | UInt32(d[at + 2]) << 8 | UInt32(d[at + 3]) }
    static func u32le(_ d: ArraySlice<UInt8>, _ at: Int) -> UInt32 {
        let b = d.startIndex + at
        return UInt32(d[b]) | UInt32(d[b + 1]) << 8 | UInt32(d[b + 2]) << 16 | UInt32(d[b + 3]) << 24
    }
    static func f64le(_ d: ArraySlice<UInt8>, _ at: Int) -> Double {
        var bits: UInt64 = 0
        for i in 0..<8 { bits |= UInt64(d[d.startIndex + at + i]) << (8 * UInt64(i)) }
        return Double(bitPattern: bits)
    }

    /// The NUL-terminated UTF-8 string at `at`, not past `end`; nil when it runs off or is not UTF-8.
    static func cString(_ page: ArraySlice<UInt8>, _ at: Int, _ end: Int) -> String? {
        if at < 0 || at >= end { return nil }
        guard let stop = page[(page.startIndex + at)..<(page.startIndex + end)].firstIndex(of: 0) else { return nil }
        let bytes = page[(page.startIndex + at)..<stop]
        return String(bytes: bytes, encoding: .utf8)
    }

    static func parseRecord(_ page: ArraySlice<UInt8>, _ start: Int) -> Cookie? {
        if start < 0 || start + recordHeader > page.count { return nil }
        let size = Int(u32le(page, start))
        if size < recordHeader || start + size > page.count { return nil }
        let end = start + size
        let flags = u32le(page, start + 8)
        let strings = [16, 20, 24, 28].map { cString(page, start + Int(u32le(page, start + $0)), end) }
        if strings.contains(where: { $0 == nil }) { return nil }
        let host = strings[0]!, name = strings[1]!, path = strings[2]!, value = strings[3]!
        if host.isEmpty || name.isEmpty { return nil }
        return Cookie(host: host, name: name, value: value, path: path.isEmpty ? "/" : path,
                      expires: macTimeToUnix(f64le(page, start + 40)), created: macTimeToUnix(f64le(page, start + 48)),
                      secure: flags & flagSecure != 0, httpOnly: flags & flagHttpOnly != 0)
    }

    public struct NotSafari: Error, LocalizedError { public let message: String; public var errorDescription: String? { message } }

    /// A whole Cookies.binarycookies file. Not Safari's file at all: thrown. A record that doesn't parse: skipped, counted.
    public static func parseBinaryCookies(_ data: Data) throws -> Parsed {
        let d = [UInt8](data)
        guard d.count >= 8, Array(d[0..<4]) == Array("cook".utf8) else { throw NotSafari(message: "Not a Safari cookie file") }
        let pages = Int(u32be(d, 4))
        let tableEnd = 8 + pages * 4
        if tableEnd > d.count { throw NotSafari(message: "Safari's cookie file is cut short") }
        var cookies: [Cookie] = []
        var skipped = 0
        var at = tableEnd
        for index in 0..<pages {
            let size = Int(u32be(d, 8 + index * 4))
            if at + size > d.count { throw NotSafari(message: "Safari's cookie file is cut short") }
            let page = d[at..<(at + size)]
            at += size
            if page.count < 8 || Array(page.prefix(4)) != [0, 0, 1, 0] { skipped += 1; continue }
            let count = Int(u32le(page, 4))
            if 8 + count * 4 > page.count { skipped += count; continue }
            for record in 0..<count {
                if let cookie = parseRecord(page, Int(u32le(page, 8 + record * 4))) { cookies.append(cookie) } else { skipped += 1 }
            }
        }
        return Parsed(cookies: cookies, skipped: skipped)
    }

    /// For the tests' fixtures: a file in Safari's format.
    public static func makeBinaryCookies(_ pages: [[(host: String, name: String, path: String, value: String, flags: UInt32, expires: Double, created: Double)]]) -> Data {
        func le32(_ v: UInt32) -> [UInt8] { [UInt8(v & 0xff), UInt8(v >> 8 & 0xff), UInt8(v >> 16 & 0xff), UInt8(v >> 24 & 0xff)] }
        func be32(_ v: UInt32) -> [UInt8] { le32(v).reversed() }
        func le64(_ v: Double) -> [UInt8] { let b = v.bitPattern; return (0..<8).map { UInt8(b >> (8 * UInt64($0)) & 0xff) } }
        var built: [[UInt8]] = []
        for records in pages {
            var bodies: [[UInt8]] = []
            for r in records {
                let strs = [r.host, r.name, r.path, r.value].map { Array($0.utf8) + [0] }
                var offs: [UInt32] = []
                var o = UInt32(recordHeader)
                for s in strs { offs.append(o); o += UInt32(s.count) }
                var rec = le32(o) + le32(0) + le32(r.flags) + le32(0)
                for off in offs { rec += le32(off) }
                rec += le32(0) + le32(0) + le64(r.expires) + le64(r.created)
                rec += strs.flatMap { $0 }
                bodies.append(rec)
            }
            var head: [UInt8] = [0, 0, 1, 0] + le32(UInt32(bodies.count))
            var offset = UInt32(8 + 4 * bodies.count + 4)
            var offsets: [UInt8] = []
            for b in bodies { offsets += le32(offset); offset += UInt32(b.count) }
            head += offsets + le32(0)
            built.append(head + bodies.flatMap { $0 })
        }
        var out = Array("cook".utf8) + be32(UInt32(built.count))
        for p in built { out += be32(UInt32(p.count)) }
        for p in built { out += p }
        return Data(out)
    }

    // ------------------------------------------------------------------------------------------------ where they are

    static func container(_ home: String) -> String { (home as NSString).appendingPathComponent("Library/Containers/com.apple.Safari/Data/Library") }
    public static func containerFile(_ home: String) -> String { (container(home) as NSString).appendingPathComponent("Cookies/Cookies.binarycookies") }
    public static func oldFile(_ home: String) -> String { (home as NSString).appendingPathComponent("Library/Cookies/Cookies.binarycookies") }
    public static func profilesDir(_ home: String) -> String { (container(home) as NSString).appendingPathComponent("WebKit/WebsiteDataStore") }
    public static func tabsDb(_ home: String) -> String { (container(home) as NSString).appendingPathComponent("Safari/SafariTabs.db") }
    static let uuid = SRx(#"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#, "i")

    public struct NeedsDiskAccess: Error, LocalizedError { public var errorDescription: String? { "Engelbart needs Full Disk Access to read Safari's sign-ins." } }

    static func guarded(_ code: Int32) -> Bool { code == EPERM || code == EACCES }

    /// Whether `file` is a file; a guarded stat thrown as NeedsDiskAccess.
    static func isFile(_ file: String) throws -> Bool {
        var st = stat()
        if stat(file, &st) != 0 { if guarded(errno) { throw NeedsDiskAccess() }; return false }
        return (st.st_mode & S_IFMT) == S_IFREG
    }

    public static func defaultCookieFile(_ home: String) throws -> String {
        if try isFile(containerFile(home)) { return containerFile(home) }
        if try isFile(oldFile(home)) { return oldFile(home) }
        return ""
    }

    /// Profile names from SafariTabs.db (UUID → name); unverified schema: anything that doesn't read gives none.
    static func profileNames(_ home: String) -> [String: String] {
        guard let db = try? SQLiteFile(tabsDb(home)) else { return [:] }
        var names: [String: String] = [:]
        for row in (try? db.rows("SELECT external_uuid AS uuid, title FROM bookmarks WHERE external_uuid IS NOT NULL AND title IS NOT NULL AND title != ''")) ?? [] {
            let id = row.text("uuid")
            if uuid.test(id) { names[id.uppercased()] = row.text("title") }
        }
        return names
    }

    public struct Profile: Equatable, Sendable { public var id: String; public var name: String; public var cookieFile: String; public var locked = false }

    /// Safari's profiles: 'Default' (the container's file, else the old one), then each Safari 17+ profile with a cookie
    /// file. Only called with Full Disk Access; a guarded read is thrown (NeedsDiskAccess).
    public static func profiles(_ home: String) throws -> [Profile] {
        var out: [Profile] = []
        let main = try defaultCookieFile(home)
        var dirs: [String] = []
        do { dirs = try FileManager.default.contentsOfDirectory(atPath: profilesDir(home)).filter { uuid.test($0) }.sorted() } catch {
            let code = ((error as NSError).userInfo[NSUnderlyingErrorKey] as? NSError)?.code ?? 0
            if guarded(Int32(code)) || (error as NSError).code == NSFileReadNoPermissionError { throw NeedsDiskAccess() }
        }
        let extra = try dirs.map { (dir: $0, file: (profilesDir(home) as NSString).appendingPathComponent("\($0)/Cookies/Cookies.binarycookies")) }.filter { try isFile($0.file) }
        let names = extra.isEmpty ? [:] : profileNames(home)
        // With profiles, Safari calls the first one "Personal" (unverified, as the names are).
        if !main.isEmpty { out.append(Profile(id: "Default", name: extra.isEmpty ? "Safari" : "Personal", cookieFile: main)) }
        for (index, entry) in extra.enumerated() { out.append(Profile(id: entry.dir, name: names[entry.dir.uppercased()] ?? "Profile \(index + 1)", cookieFile: entry.file)) }
        return out
    }

    /// A Safari cookie file read and parsed; a guarded read thrown as NeedsDiskAccess.
    public static func readFile(_ file: String) throws -> Parsed {
        do { return try parseBinaryCookies(try StageFiles.readBytes(file)) } catch let failure as StageFiles.Failure {
            if let code = failure.code, guarded(code) { throw NeedsDiskAccess() }
            throw failure
        }
    }

    /// Whether a parsed Safari cookie is live (`now` Unix seconds): one with no expiry on disk counts as live.
    public static func kept(_ cookie: Cookie, now: Int) -> Bool { !(cookie.expires > 0 && cookie.expires <= now) }
}
