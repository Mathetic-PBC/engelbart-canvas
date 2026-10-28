import Foundation
import EngelbartCore

// Small pieces the ported modules share: JavaScript's clock and timers as injectable closures (the tests' fake clocks),
// JSON text the way JSON.stringify writes it, and the write-then-rename files with their modes.

/// `Date.now()` in milliseconds.
public typealias NowMs = @Sendable () -> Double
/// `await sleep(ms)`; throws when the wait is stopped.
public typealias SleepMs = @Sendable (Double) async throws -> Void

public let systemNow: NowMs = { Date().timeIntervalSince1970 * 1000 }
public let systemSleep: SleepMs = { ms in try await Task.sleep(nanoseconds: UInt64(max(0, ms) * 1_000_000)) }

enum JSONText {
    /// `JSON.stringify(value, null, indent)` (keys sorted, for stable files); indent 0 is the compact form.
    static func stringify(_ value: JSONValue, indent: Int = 0) -> String {
        var out = ""
        write(value, indent: indent, depth: 0, into: &out)
        return out
    }

    private static func write(_ value: JSONValue, indent: Int, depth: Int, into out: inout String) {
        let pad = indent > 0 ? "\n" + String(repeating: " ", count: indent * (depth + 1)) : ""
        let close = indent > 0 ? "\n" + String(repeating: " ", count: indent * depth) : ""
        switch value {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .number(let n): out += number(n)
        case .string(let s): out += quote(s)
        case .array(let a):
            if a.isEmpty { out += "[]"; return }
            out += "["
            for (i, item) in a.enumerated() {
                if i > 0 { out += "," }
                out += pad
                write(item, indent: indent, depth: depth + 1, into: &out)
            }
            out += close + "]"
        case .object(let o):
            if o.isEmpty { out += "{}"; return }
            out += "{"
            for (i, key) in o.keys.sorted().enumerated() {
                if i > 0 { out += "," }
                out += pad + quote(key) + (indent > 0 ? ": " : ":")
                write(o[key]!, indent: indent, depth: depth + 1, into: &out)
            }
            out += close + "}"
        }
    }

    static func number(_ n: Double) -> String {
        if !n.isFinite { return "null" }
        if n.rounded() == n && abs(n) < 1e21 { return String(format: "%.0f", n) }
        var s = String(n)
        if s.hasSuffix(".0") { s.removeLast(2) }
        return s
    }

    static func quote(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) } else { out.unicodeScalars.append(scalar) }
            }
        }
        return out + "\""
    }
}

enum FileOps {
    /// Write-then-rename beside the file, the mode set on the temporary file first (Electron's `${file}.${pid}.tmp`).
    static func write(_ data: Data, to path: String, mode: Int16? = nil) throws {
        try Files.writeAtomically(data, to: URL(fileURLWithPath: path), mode: mode)
    }

    static func write(_ text: String, to path: String, mode: Int16? = nil) throws {
        try write(Data(text.utf8), to: path, mode: mode)
    }

    static func read(_ path: String) -> String? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    static func readJSON(_ path: String) -> JSONValue? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return try? JSONValue.parse(data)
    }

    static func isFile(_ path: String) -> Bool {
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &dir) && !dir.boolValue
    }

    static func isDirectory(_ path: String) -> Bool {
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &dir) && dir.boolValue
    }

    static func exists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }

    /// `fs.rmSync(path, { recursive: true, force: true })`.
    static func remove(_ path: String) { try? FileManager.default.removeItem(atPath: path) }

    static func mkdir(_ path: String, mode: Int? = nil) {
        var attributes: [FileAttributeKey: Any]? = nil
        if let mode { attributes = [.posixPermissions: mode] }
        try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: attributes)
    }

    static func list(_ path: String) -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []
    }

    static func size(_ path: String) -> Int? {
        (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.intValue
    }

    static func mtimeMs(_ path: String) -> Double? {
        guard let date = try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date else { return nil }
        return date.timeIntervalSince1970 * 1000
    }
}

func join(_ parts: String...) -> String {
    parts.reduce("") { acc, part in
        if acc.isEmpty { return part }
        if part.isEmpty { return acc }
        return (acc as NSString).appendingPathComponent(part)
    }
}

extension JSONValue {
    /// JavaScript's truthiness of a value.
    var truthy: Bool {
        switch self {
        case .null: return false
        case .bool(let b): return b
        case .number(let n): return n != 0 && !n.isNaN
        case .string(let s): return !s.isEmpty
        case .array, .object: return true
        }
    }

    /// `String(value || '')` for strings; '' for anything else that is not a string or a number.
    var stringish: String {
        switch self {
        case .string(let s): return s
        case .number(let n): return JSONText.number(n)
        case .bool(let b): return b ? "true" : "false"
        default: return ""
        }
    }

    /// `Number(value)` when it is a finite number (or numeric string).
    var numberish: Double? {
        switch self {
        case .number(let n): return n.isFinite ? n : nil
        case .string(let s): return Double(s.trimmingCharacters(in: .whitespaces))
        default: return nil
        }
    }

    func with(_ key: String, _ value: JSONValue?) -> JSONValue {
        guard case .object(var o) = self else { return self }
        o[key] = value
        return .object(o)
    }
}

/// `String(text).slice(0, max)` by UTF-16 units, as JavaScript cuts.
func jsSlice(_ text: String, _ max: Int) -> String {
    let units = Array(text.utf16)
    if units.count <= max { return text }
    return String(decoding: units[0..<max], as: UTF16.self)
}

/// JavaScript's string length (UTF-16 units).
func jsLength(_ text: String) -> Int { text.utf16.count }

/// `n.toLocaleString('en-US')`: thousands with commas.
func grouped(_ n: Int) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.locale = Locale(identifier: "en_US")
    return f.string(from: NSNumber(value: n)) ?? String(n)
}

extension NSRegularExpression {
    convenience init(_ pattern: String, _ options: NSRegularExpression.Options = []) {
        try! self.init(pattern: pattern, options: options)
    }

    func test(_ text: String) -> Bool {
        firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// The groups of the first match (index 0 the whole), nil for a group that did not take part.
    func groups(_ text: String) -> [String?]? {
        guard let m = firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let r = m.range(at: i)
            guard r.location != NSNotFound, let range = Range(r, in: text) else { return nil }
            return String(text[range])
        }
    }

    func replace(_ text: String, with template: String) -> String {
        stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    func allGroups(_ text: String) -> [[String?]] {
        matches(in: text, range: NSRange(text.startIndex..., in: text)).map { m in
            (0..<m.numberOfRanges).map { i in
                let r = m.range(at: i)
                guard r.location != NSNotFound, let range = Range(r, in: text) else { return nil }
                return String(text[range])
            }
        }
    }
}

func re(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
    NSRegularExpression(pattern, options)
}

/// A replace with a closure over each match's groups.
func replaceMatches(_ regex: NSRegularExpression, in text: String, _ transform: ([String?]) -> String) -> String {
    let ns = text as NSString
    var out = ""
    var last = 0
    for m in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
        let groups: [String?] = (0..<m.numberOfRanges).map { i in
            let r = m.range(at: i)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }
        out += transform(groups)
        last = m.range.location + m.range.length
    }
    out += ns.substring(from: last)
    return out
}

/// `new Date(ms).toISOString()`.
func isoString(_ ms: Double) -> String { Time.iso(Date(timeIntervalSince1970: ms / 1000)) }

/// `Date.parse(text)` in ms, or nil.
func parseISO(_ text: String) -> Double? {
    Time.parse(text).map { $0.timeIntervalSince1970 * 1000 }
}

/// A box for state shared with escaping closures in tests and flows.
final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}
