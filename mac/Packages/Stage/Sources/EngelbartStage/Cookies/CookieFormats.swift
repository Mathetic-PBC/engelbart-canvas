import Foundation
import CommonCrypto
import SQLite3

// Reading the person's browsers' cookies (MATH-18, src/main/browser/import-cookies.cjs and safari-cookies.cjs): the pure
// parts, which the tests drive with fixtures. Nothing here touches a real profile or the Keychain: the importer
// (CookieImport.swift) is handed the folders and the Keychain runner.
//
// Reference, not a dependency (CK-06): the v10 decryption and the >= 24 hash-prefix strip follow what
// read-browser-cookies and yt-dlp do for Chromium on macOS; the Safari parser follows yt-dlp's _parse_safari_cookies and
// browser_cookie3's Safari class (both read 2026-10-16).

/// One cookie, normalized, ready to be written (never shown, never recorded).
public struct ImportedCookie: Equatable, Sendable {
    public var host: String
    public var name: String
    public var value: String
    public var path: String
    public var secure: Bool
    public var httpOnly: Bool
    /// 'unspecified' | 'no_restriction' | 'lax' | 'strict'
    public var sameSite: String
    public var persistent: Bool
    /// Unix seconds; 0 for none.
    public var expires: Int
}

/// cookies.set's details for one cookie (CK-08, CK-09).
public struct CookieSetDetails: Equatable, Sendable {
    public var url: String
    public var name: String
    public var value: String
    public var path: String
    public var secure: Bool
    public var httpOnly: Bool
    public var sameSite: String
    public var domain: String?
    public var expirationDate: Int?

    /// The same cookie for WebKit's store. A session cookie has no expiry and lasts as long as the Stage runs.
    public var httpCookie: HTTPCookie? {
        guard let host = JSURL(url)?.hostname else { return nil }
        var props: [HTTPCookiePropertyKey: Any] = [.name: name, .value: value, .path: path, .domain: domain ?? host]
        if secure { props[.secure] = "TRUE" }
        if let expirationDate { props[.expires] = Date(timeIntervalSince1970: TimeInterval(expirationDate)) } else { props[.discard] = "TRUE" }
        if httpOnly { props[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
        switch sameSite {
        case "lax": props[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteLax
        case "strict": props[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict
        case "no_restriction": props[.sameSitePolicy] = "none"
        default: break
        }
        if domain == nil { props[.originURL] = url } // host-only: no leading dot
        return HTTPCookie(properties: props)
    }
}

public enum CookieFormats {
    public static let windowsToUnixSeconds: Double = 11_644_473_600
    static let v10 = Data("v10".utf8)
    static let iv = Data(repeating: 0x20, count: 16) // 16 spaces, the macOS Chromium IV

    /// The key macOS Chromium derives from its Keychain password: PBKDF2-SHA1, salt 'saltysalt', 1003 rounds, 16 bytes.
    public static func deriveKey(_ password: String) -> Data {
        var key = Data(count: 16)
        let pass = Array(password.utf8)
        let salt = Array("saltysalt".utf8)
        _ = key.withUnsafeMutableBytes { out in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pass.map { Int8(bitPattern: $0) }, pass.count, salt, salt.count,
                                 CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), 1003, out.bindMemory(to: UInt8.self).baseAddress, 16)
        }
        return key
    }

    static func crypt(_ op: Int, _ data: Data, key: Data) -> Data? {
        var out = Data(count: data.count + kCCBlockSizeAES128)
        var moved = 0
        let outCount = out.count
        let status = out.withUnsafeMutableBytes { o in
            data.withUnsafeBytes { d in key.withUnsafeBytes { k in iv.withUnsafeBytes { v in
                CCCrypt(CCOperation(op), CCAlgorithm(kCCAlgorithmAES128), CCOptions(kCCOptionPKCS7Padding), k.baseAddress, key.count, v.baseAddress,
                        d.baseAddress, data.count, o.baseAddress, outCount, &moved)
            } } }
        }
        guard status == kCCSuccess else { return nil }
        return out.prefix(moved)
    }

    /// For the tests' fixtures: a value as Chromium writes it ('v10' + AES-128-CBC), a 32-byte hash first for meta ≥ 24.
    public static func encryptV10(_ value: String, key: Data, hashPrefix: Data? = nil) -> Data {
        v10 + (crypt(kCCEncrypt, (hashPrefix ?? Data()) + Data(value.utf8), key: key) ?? Data())
    }

    /// One Chromium cookie value, decrypted (CK-06): values in the clear as they are; v10 AES with the derived key, a 32-byte
    /// hash dropped for meta ≥ 24; anything that will not decrypt cleanly is nil (skipped and counted by the caller).
    public static func decryptChromiumValue(_ encrypted: Data, plainValue: String?, key: Data?, metaVersion: Int) -> String? {
        if encrypted.isEmpty { return plainValue ?? "" }
        if encrypted.prefix(3) != v10 { return (plainValue?.isEmpty == false) ? plainValue : nil }
        // a body that is no whole number of AES blocks will not decrypt (Node throws "wrong final block length")
        let body = encrypted.dropFirst(3)
        guard let key, !body.isEmpty, body.count % kCCBlockSizeAES128 == 0, var plain = crypt(kCCDecrypt, Data(body), key: key) else { return nil }
        if metaVersion >= 24 {
            if plain.count < 32 { return nil }
            plain = plain.dropFirst(32)
        }
        return String(data: plain, encoding: .utf8) ?? String(decoding: plain, as: UTF8.self)
    }

    /// Chromium's microseconds-since-1601 to Unix seconds; 0 (no expiry recorded) stays 0.
    public static func chromeTimeToUnixSeconds(_ microseconds: Double) -> Int {
        guard microseconds.isFinite, microseconds > 0 else { return 0 }
        return Int((microseconds / 1e6 - windowsToUnixSeconds).rounded(.down))
    }

    // Chromium's `samesite` column: -1 unspecified, 0 None, 1 Lax, 2 Strict (CK-08). Firefox's: 0 unset, 1 Lax, 2 Strict.
    public static let chromiumSameSite = [-1: "unspecified", 0: "no_restriction", 1: "lax", 2: "strict"]
    public static let firefoxSameSite = [0: "unspecified", 1: "lax", 2: "strict"]
    public static func sameSiteOf(_ table: [Int: String], _ value: Int) -> String { table[value] ?? "unspecified" }

    static func stripLeadingDot(_ host: String) -> String { host.hasPrefix(".") ? String(host.dropFirst()) : host }

    static let multiSuffix: Set<String> = ["co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "co.nz", "co.za", "com.au", "com.br", "co.in"]

    /// The registrable domain of a host, for grouping and matching ('.www.github.com' → 'github.com').
    public static func registrableDomain(_ host: String) -> String {
        let clean = stripLeadingDot(host).lowercased()
        let labels = clean.split(separator: ".").map(String.init)
        if labels.count <= 2 { return clean }
        let lastTwo = labels.suffix(2).joined(separator: ".")
        if multiSuffix.contains(lastTwo) { return labels.suffix(3).joined(separator: ".") }
        return lastTwo
    }

    /// The details for one normalized cookie: a leading-dot host keeps its domain, a host-only cookie gets none, a
    /// `__Host-` cookie never has one; a persistent cookie keeps its expiry in Unix seconds.
    public static func cookieSetDetails(_ cookie: ImportedCookie) -> CookieSetDetails {
        let host = stripLeadingDot(cookie.host)
        let path = cookie.path.isEmpty ? "/" : cookie.path
        let url = "\(cookie.secure ? "https" : "http")://\(host)\(path.hasPrefix("/") ? "" : "/")\(path)"
        var details = CookieSetDetails(url: url, name: cookie.name, value: cookie.value, path: path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite.isEmpty ? "unspecified" : cookie.sameSite)
        if !cookie.name.hasPrefix("__Host-") && cookie.host.hasPrefix(".") { details.domain = cookie.host }
        if cookie.persistent && cookie.expires > 0 { details.expirationDate = cookie.expires }
        return details
    }

    // Google's cookies tied to the browser that made them (2026-10-12): never copied, counted as skipped.
    public static let googleBoundCookies: Set<String> = ["SIDCC", "__Secure-1PSIDCC", "__Secure-3PSIDCC", "__Secure-STRP", "AEC"]
    public static func boundToBrowser(host: String, name: String) -> Bool {
        SRx(#"^google\.[a-z.]+$"#).test(registrableDomain(host)) && googleBoundCookies.contains(name)
    }

    // ------------------------------------------------------------------------------------------------ the databases

    public struct ChromiumRow: Equatable, Sendable {
        public var host, name, plainValue: String
        public var encrypted: Data
        public var path: String
        public var expiresUtc: Double
        public var secure, httpOnly: Bool
        public var samesite: Int
        public var persistent, hasExpires: Bool
        public var topFrameSiteKey: String
        public var stamp: Double
    }

    public struct FirefoxRow: Equatable, Sendable {
        public var host, name, plainValue, path: String
        public var expirySeconds: Int
        public var secure, httpOnly: Bool
        public var samesite: Int
        public var originAttributes: String
        public var stamp: Double
    }

    /// A private copy of `source` and its -wal/-shm siblings in a fresh temp folder, read by `read`, deleted after (CK-04).
    public static func withCopy<T>(_ source: String, tmpBase: URL, _ read: (String) throws -> T) throws -> T {
        let dir = tmpBase.appendingPathComponent("engelbart-cookies-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: dir) }
        let copy = dir.appendingPathComponent("Cookies").path
        try FileManager.default.copyItem(atPath: source, toPath: copy)
        for suffix in ["-wal", "-shm"] where FileManager.default.fileExists(atPath: source + suffix) {
            try FileManager.default.copyItem(atPath: source + suffix, toPath: copy + suffix)
        }
        return try read(copy)
    }

    /// Every row of a Chromium Cookies database, column names handled across versions; values not decrypted here.
    public static func readChromiumDb(_ file: String) throws -> (version: Int, rows: [ChromiumRow]) {
        let db = try SQLiteFile(file)
        let cols = db.columns("cookies")
        let secureCol = cols.contains("is_secure") ? "is_secure" : "secure"
        let httpCol = cols.contains("is_httponly") ? "is_httponly" : "httponly"
        let version = Int(db.scalar("SELECT value FROM meta WHERE key = 'version'") ?? "") ?? 0
        let rows = try db.rows("SELECT * FROM cookies").map { r -> ChromiumRow in
            ChromiumRow(host: r.text("host_key"), name: r.text("name"), plainValue: r.text("value"), encrypted: r.blob("encrypted_value"), path: r.text("path", "/"),
                        expiresUtc: r.number("expires_utc"), secure: r.number(secureCol) != 0, httpOnly: r.number(httpCol) != 0,
                        samesite: cols.contains("samesite") ? Int(r.number("samesite")) : -1,
                        persistent: cols.contains("is_persistent") ? r.number("is_persistent") != 0 : true,
                        hasExpires: cols.contains("has_expires") ? r.number("has_expires") != 0 : true,
                        topFrameSiteKey: cols.contains("top_frame_site_key") ? r.text("top_frame_site_key") : "",
                        stamp: r.number(cols.contains("last_update_utc") ? "last_update_utc" : "creation_utc"))
        }
        return (version, rows)
    }

    /// Firefox's cookie schema 14 stores expiry in milliseconds; before it, seconds.
    public static let firefoxExpiryMsSchema = 14

    /// Every row of a Firefox cookies.sqlite (CK-02): values in the clear; expiry in Unix seconds whatever the schema.
    public static func readFirefoxDb(_ file: String) throws -> (schema: Int, rows: [FirefoxRow]) {
        let db = try SQLiteFile(file)
        let cols = db.columns("moz_cookies")
        let schema = Int(db.scalar("PRAGMA user_version") ?? "") ?? 0
        let rows = try db.rows("SELECT * FROM moz_cookies").map { r -> FirefoxRow in
            let expiry = r.number("expiry")
            return FirefoxRow(host: r.text("host"), name: r.text("name"), plainValue: r.text("value"), path: r.text("path", "/"),
                              expirySeconds: schema >= firefoxExpiryMsSchema ? Int((expiry / 1000).rounded(.down)) : Int(expiry),
                              secure: r.number("isSecure") != 0, httpOnly: r.number("isHttpOnly") != 0,
                              samesite: cols.contains("sameSite") ? Int(r.number("sameSite")) : 0,
                              originAttributes: cols.contains("originAttributes") ? r.text("originAttributes") : "", stamp: r.number("creationTime"))
        }
        return (schema, rows)
    }

    /// Whether a Chromium row is the plain, live cookie: not partitioned (CHIPS), not expired. `now` Unix seconds.
    public static func chromiumKept(_ row: ChromiumRow, now: Int) -> Bool {
        if !row.topFrameSiteKey.isEmpty { return false }
        let expires = chromeTimeToUnixSeconds(row.expiresUtc)
        return !(row.persistent && row.hasExpires && expires > 0 && expires <= now)
    }

    public static func firefoxKept(_ row: FirefoxRow, now: Int) -> Bool {
        if !row.originAttributes.isEmpty { return false }
        return !(row.expirySeconds > 0 && row.expirySeconds <= now)
    }

    /// Chromium rows → cookies, decrypting values and dropping those that will not decrypt (counted); `want` scopes both.
    public static func normalizeChromium(version: Int, rows: [ChromiumRow], key: Data?, want: Set<String>? = nil, now: Int) -> (cookies: [ImportedCookie], skipped: Int) {
        var cookies: [ImportedCookie] = []
        var skipped = 0
        for row in rows {
            if let want, !want.contains(registrableDomain(row.host)) { continue }
            if !chromiumKept(row, now: now) { continue }
            guard let value = decryptChromiumValue(row.encrypted, plainValue: row.plainValue, key: key, metaVersion: version) else { skipped += 1; continue }
            cookies.append(ImportedCookie(host: row.host, name: row.name, value: value, path: row.path, secure: row.secure, httpOnly: row.httpOnly,
                                          sameSite: sameSiteOf(chromiumSameSite, row.samesite), persistent: row.persistent && row.hasExpires, expires: chromeTimeToUnixSeconds(row.expiresUtc)))
        }
        return (cookies, skipped)
    }

    public static func normalizeFirefox(rows: [FirefoxRow], want: Set<String>? = nil, now: Int) -> (cookies: [ImportedCookie], skipped: Int) {
        let cookies = rows.filter { (want == nil || want!.contains(registrableDomain($0.host))) && firefoxKept($0, now: now) }.map {
            ImportedCookie(host: $0.host, name: $0.name, value: $0.plainValue, path: $0.path, secure: $0.secure, httpOnly: $0.httpOnly,
                           sameSite: sameSiteOf(firefoxSameSite, $0.samesite), persistent: $0.expirySeconds > 0, expires: $0.expirySeconds)
        }
        return (cookies, 0)
    }

    public static func normalizeSafari(_ parsed: SafariCookies.Parsed, want: Set<String>? = nil, now: Int) -> (cookies: [ImportedCookie], skipped: Int) {
        let cookies = parsed.cookies.filter { (want == nil || want!.contains(registrableDomain($0.host))) && SafariCookies.kept($0, now: now) }.map {
            ImportedCookie(host: $0.host, name: $0.name, value: $0.value, path: $0.path, secure: $0.secure, httpOnly: $0.httpOnly, sameSite: "unspecified", persistent: $0.expires > 0, expires: $0.expires)
        }
        return (cookies, parsed.skipped)
    }
}

/// A read of one SQLite file through the system library (the Electron code used node:sqlite).
final class SQLiteFile {
    private var db: OpaquePointer?

    init(_ path: String) throws {
        if sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, nil) != SQLITE_OK {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "cannot open"
            sqlite3_close(db)
            throw CookieImportError(message: "This cookie database could not be read (\(message)).")
        }
    }
    deinit { sqlite3_close(db) }

    struct Row {
        let values: [String: Any]
        func text(_ k: String, _ fallback: String = "") -> String {
            if let s = values[k] as? String { return s.isEmpty && fallback != "" ? fallback : s }
            return fallback
        }
        func number(_ k: String) -> Double {
            if let n = values[k] as? Int64 { return Double(n) }
            if let d = values[k] as? Double { return d }
            if let s = values[k] as? String { return Double(s) ?? 0 }
            return 0
        }
        func blob(_ k: String) -> Data { values[k] as? Data ?? Data() }
    }

    func rows(_ sql: String) throws -> [Row] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw CookieImportError(message: String(cString: sqlite3_errmsg(db))) }
        defer { sqlite3_finalize(statement) }
        var out: [Row] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            var values: [String: Any] = [:]
            for i in 0..<sqlite3_column_count(statement) {
                let name = String(cString: sqlite3_column_name(statement, i))
                switch sqlite3_column_type(statement, i) {
                case SQLITE_INTEGER: values[name] = sqlite3_column_int64(statement, i)
                case SQLITE_FLOAT: values[name] = sqlite3_column_double(statement, i)
                case SQLITE_TEXT: values[name] = String(cString: sqlite3_column_text(statement, i))
                case SQLITE_BLOB:
                    let n = Int(sqlite3_column_bytes(statement, i))
                    values[name] = n > 0 ? Data(bytes: sqlite3_column_blob(statement, i), count: n) : Data()
                default: break
                }
            }
            out.append(Row(values: values))
        }
        return out
    }

    func scalar(_ sql: String) -> String? {
        guard let row = try? rows(sql).first, let value = row.values.values.first else { return nil }
        return "\(value)"
    }

    func columns(_ table: String) -> Set<String> {
        Set(((try? rows("PRAGMA table_info(\(table))")) ?? []).map { $0.text("name") })
    }
}
