import Foundation
import CryptoKit
import EngelbartCore

// Port of src/main/connect/apple-notes.cjs (Connect your library, 2026-10-07, second build): Apple Notes, asked through
// macOS Automation (JavaScript for Automation run by osascript). Notes keeps its notes in a database no other app may read,
// so Engelbart asks Notes itself, in the background: Notes is never brought forward and nothing is clicked. The first
// time, macOS asks the person to let Engelbart control Notes; after a refusal every call fails with NOT_ALLOWED until they
// allow it in System Settings → Privacy & Security → Automation. Only reads.

public struct AppleNotes: @unchecked Sendable {
    public static let timeout: TimeInterval = 120
    public static let maxNotes = 5000
    static let idRE = #"^x-coredata://[\w./-]{1,200}$"#
    public static let notAllowed = Texts.appleNotesNotAllowed

    /// Runs osascript (`-l JavaScript -e SCRIPT command json`) → (stdout, stderr, failed message). Replaced in tests.
    public typealias Runner = (_ arguments: [String]) async -> (stdout: String, stderr: String, error: String?)

    public var run: Runner
    public var isMac: Bool

    public init(run: Runner? = nil, isMac: Bool = true) {
        self.isMac = isMac
        self.run = run ?? { arguments in
            do {
                let result = try await ProcessRunner.run("/usr/bin/osascript", arguments, timeout: AppleNotes.timeout)
                if result.exit.succeeded { return (result.stdout, result.stderr, nil) }
                return (result.stdout, result.stderr, "Command failed: osascript")
            } catch {
                return ("", "", error.localizedDescription)
            }
        }
    }

    func call(_ command: String, _ args: JSONValue) async throws -> JSONValue {
        guard isMac else { throw ConnectError("failed", "Apple Notes is only on a Mac") }
        let out = await run(["-l", "JavaScript", "-e", Texts.appleNotesScript, command, args.text()])
        if let message = out.error {
            let said = "\(out.stderr) \(message)"
            if JS.test(said, #"-1743|not authori[sz]ed|not allowed"#, options: .caseInsensitive) { throw ConnectError("not-allowed", Self.notAllowed) }
            let first = (out.stderr.isEmpty ? message : out.stderr).trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")[0]
            throw ConnectError("failed", "Apple Notes did not answer (\(String(first.prefix(200))))")
        }
        let text = out.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        do { return try JSONValue.parse(text.isEmpty ? "null" : text) } catch { throw ConnectError("failed", "Apple Notes answered something unreadable") }
    }

    /// Asks Notes for its folders, which makes macOS ask the person once.
    public func permission() async -> (allowed: Bool, error: String, refused: Bool) {
        do { _ = try await call("folders", [:]); return (true, "", false) } catch let e as ConnectError { return (false, e.message, e.kind == "not-allowed") } catch { return (false, error.localizedDescription, false) }
    }

    public func folders() async throws -> JSONValue { try await call("folders", [:]) }

    /// Notes newest first → [{ id, name, folder, account, modified }]: in `folder` (an id or a name), changed in `days`, matching `query`.
    public func list(folder: String = "", days: Double? = nil, query: String = "", limit: Double = 500, now: Date = Date()) async throws -> [JSONValue] {
        let rows = (try await call("list", ["folder": .string(folder), "max": .number(Double(Self.maxNotes))])).array ?? []
        let since = (days.map { $0.isFinite && $0 > 0 } ?? false) ? Time.ms(now) - days! * 86_400_000 : 0
        let words = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let cap = Swift.min(Swift.max(1, limit.isFinite && limit.rounded() != 0 ? Int(limit.rounded()) : 500), Self.maxNotes)
        return rows.filter { row in
            guard case .object = row, JS.test(JS.string(row["id"]), Self.idRE), !JS.test(JS.string(row["folder"]), "recently deleted", options: .caseInsensitive) else { return false }
            if since > 0 { guard let d = Time.parse(JS.string(row["modified"])), Time.ms(d) >= since else { return false } }
            if !words.isEmpty { let hay = "\(JS.string(row["name"])) \(JS.string(row["folder"]))".lowercased(); if !words.allSatisfy({ hay.contains($0) }) { return false } }
            return true
        }.sorted { JS.string($0["modified"]).compare(JS.string($1["modified"])) == .orderedDescending }.prefix(cap).map { $0 }
    }

    public struct Note: Sendable, Equatable { public var id: String; public var name: String; public var folder: String; public var modified: String?; public var markdown: String; public var error: String? }

    /// Notes by id, pictures written into `pictureDir`; a note Notes could not read comes back with its error.
    public func read(_ ids: [String], pictureDir: String = "") async throws -> [Note] {
        let clean = ids.filter { JS.test($0, Self.idRE) }
        var out: [Note] = []
        var i = 0
        while i < clean.count {
            let batch = Array(clean[i..<Swift.min(i + 25, clean.count)])
            for note in (try await call("read", ["ids": .array(batch.map { .string($0) })])).array ?? [] {
                if note.isNull || JS.truthy(note["error"]) {
                    out.append(Note(id: JS.string(note["id"]), name: "", folder: "", modified: nil, markdown: "", error: note.isNull ? "not read" : JS.string(note["error"])))
                    continue
                }
                let id = JS.string(note["id"])
                let key = Insecure.SHA1.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined().prefix(10)
                let name = JS.truthy(note["name"]) ? JS.string(note["name"]) : "Untitled note"
                out.append(Note(id: id, name: String(name.prefix(200)), folder: JS.string(note["folder"]), modified: note["modified"]?.string,
                                markdown: Self.noteMarkdown(JS.string(note["body"]), name: JS.string(note["name"]), pictureDir: pictureDir, key: String(key)), error: nil))
            }
            i += 25
        }
        return out
    }

    static let entities = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " "]

    static func decode(_ text: String) -> String {
        let ns = text as NSString
        guard let re = try? NSRegularExpression(pattern: "&(#x?[0-9a-f]+|\\w+);", options: .caseInsensitive) else { return text }
        var out = "", last = 0
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let whole = ns.substring(with: m.range), name = ns.substring(with: m.range(at: 1))
            if name.hasPrefix("#") {
                let hex = name.dropFirst().lowercased().hasPrefix("x")
                let digits = hex ? String(name.dropFirst(2)) : String(name.dropFirst())
                if let code = UInt32(digits, radix: hex ? 16 : 10), let scalar = Unicode.Scalar(code) { out += String(Character(scalar)) } else { out += whole }
            } else {
                out += entities[name.lowercased()] ?? whole
            }
            last = m.range.location + m.range.length
        }
        return out + ns.substring(from: last)
    }

    /// Replaces each match of `pattern` with `transform(groups)`.
    static func sub(_ text: String, _ pattern: String, options: NSRegularExpression.Options = [.caseInsensitive], _ transform: ([String]) -> String) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { return text }
        let ns = text as NSString
        var out = "", last = 0
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let groups = (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
            out += transform(groups)
            last = m.range.location + m.range.length
        }
        return out + ns.substring(from: last)
    }

    /// A note's HTML body as Markdown. Pictures pasted into it (data: images) are written into `pictureDir` and linked by
    /// their path. The first line, the note's own title, is dropped.
    public static func noteMarkdown(_ html: String, name: String = "", pictureDir: String = "", key: String = "") -> String {
        var n = 0
        var text = sub(html, #"<img[^>]*src="data:image/(png|jpe?g|gif|webp);base64,([^"]+)"[^>]*>"#) { g in
            if pictureDir.isEmpty { return "" }
            n += 1
            try? FileManager.default.createDirectory(atPath: pictureDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let kind = g[1].lowercased()
            let file = (pictureDir as NSString).appendingPathComponent("\(key.isEmpty ? "note" : key)-\(n).\(kind == "jpeg" ? "jpg" : kind)")
            if let data = Data(base64Encoded: g[2], options: .ignoreUnknownCharacters) {
                FileManager.default.createFile(atPath: file, contents: data, attributes: [.posixPermissions: 0o600])
            }
            return "\n![picture \(n)](\(file))\n"
        }
        text = JS.replace(text, #"<br\s*/?>"#, "\n", options: .caseInsensitive)
        text = sub(text, #"<h([1-3])[^>]*>([\s\S]*?)</h\1>"#) { g in "\n\(String(repeating: "#", count: Int(g[1]) ?? 1)) \(g[2])\n" }
        text = JS.replace(text, "<li[^>]*>", "\n- ", options: .caseInsensitive)
        text = JS.replace(text, "</li>", "", options: .caseInsensitive)
        text = JS.replace(text, #"<(b|strong)>([\s\S]*?)</\1>"#, "**$2**", options: .caseInsensitive)
        text = JS.replace(text, #"<(i|em)>([\s\S]*?)</\1>"#, "*$2*", options: .caseInsensitive)
        text = JS.replace(text, #"<(strike|s|del)>([\s\S]*?)</\1>"#, "~~$2~~", options: .caseInsensitive)
        text = sub(text, #"<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>"#) { g in "[\(g[2])](\(g[1]))" }
        text = JS.replace(text, #"</(div|p|ul|ol|h\d|tr|table)>"#, "\n", options: .caseInsensitive)
        text = JS.replace(text, "<[^>]+>", "")
        text = decode(text)
        text = JS.replace(text, #"[ \t]+\n"#, "\n")
        text = JS.replace(text, #"\n{3,}"#, "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
        var lines = text.components(separatedBy: "\n")
        if !name.isEmpty, let first = lines.first, !first.isEmpty,
           JS.replace(first, #"^#+\s*"#, "").replacingOccurrences(of: "*", with: "").trimmingCharacters(in: .whitespacesAndNewlines) == name.trimmingCharacters(in: .whitespacesAndNewlines) {
            lines.removeFirst()
        }
        return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
