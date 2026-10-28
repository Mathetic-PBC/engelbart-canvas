import Foundation
import EngelbartCore

/// Main-actor state read from any thread: at once on the main thread, else synchronously on it. The tools and the browser
/// pages run off the main thread while the session they read lives on it (Electron had one thread; this is its mapping).
func onMain<T>(_ body: @MainActor () -> T) -> T {
    if Thread.isMainThread { return MainActor.assumeIsolated(body) }
    return DispatchQueue.main.sync { MainActor.assumeIsolated(body) }
}

/// The few JavaScript coercions the Electron code leans on (`String(x)`, truthiness, `slice(0, n - 1) + '…'`), so the
/// ported functions read like their sources and answer the same for loose JSON.
public enum JS {
    /// `String(value == null ? '' : value)`.
    public static func string(_ value: Any?) -> String {
        switch value {
        case nil: return ""
        case let v as JSONValue:
            switch v {
            case .null: return ""
            case .string(let s): return s
            case .bool(let b): return b ? "true" : "false"
            case .number(let n): return number(n)
            case .array(let a): return a.map { $0.isNull ? "" : string($0) }.joined(separator: ",")
            case .object: return "[object Object]"
            }
        case let v as JSONValue?: return v.map { string($0) } ?? ""
        case let s as String: return s
        case let s as Substring: return String(s)
        case let b as Bool: return b ? "true" : "false"
        case let i as Int: return String(i)
        case let d as Double: return number(d)
        default: return "\(value!)"
        }
    }

    /// A number as JavaScript prints it (`5`, not `5.0`).
    public static func number(_ n: Double) -> String {
        if n.isNaN { return "NaN" }
        if n.isInfinite { return n > 0 ? "Infinity" : "-Infinity" }
        if n.rounded() == n, abs(n) < 1e21 { return String(Int64(n)) }
        return String(n)
    }

    /// JavaScript truthiness of a JSON value (`null`, `false`, `0`, `''` are falsy; objects and arrays truthy).
    public static func truthy(_ value: JSONValue?) -> Bool {
        guard let value else { return false }
        switch value {
        case .null: return false
        case .bool(let b): return b
        case .number(let n): return n != 0 && !n.isNaN
        case .string(let s): return !s.isEmpty
        case .array, .object: return true
        }
    }

    /// `text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text`, counting characters.
    public static func cut(_ text: String, _ max: Int) -> String {
        guard text.count > max else { return text }
        let head = String(text.prefix(Swift.max(0, max - 1)))
        return trimEnd(head) + "…"
    }

    public static func trimEnd(_ text: String) -> String {
        var s = Substring(text)
        while let last = s.last, last.isWhitespace { s.removeLast() }
        return String(s)
    }

    public static func trimStart(_ text: String) -> String {
        var s = Substring(text)
        while let first = s.first, first.isWhitespace { s.removeFirst() }
        return String(s)
    }

    /// `text.replace(regex, replacement)` with JS `$1` groups (NSRegularExpression templates use the same `$1`).
    public static func replace(_ text: String, _ pattern: String, _ template: String, options: NSRegularExpression.Options = []) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { return text }
        return re.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    public static func test(_ text: String, _ pattern: String, options: NSRegularExpression.Options = []) -> Bool {
        guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { return false }
        return re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// The capture groups of the first match (index 0 the whole match), nil when none.
    public static func match(_ text: String, _ pattern: String, options: NSRegularExpression.Options = []) -> [String?]? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: options),
              let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let r = m.range(at: i)
            guard r.location != NSNotFound, let range = Range(r, in: text) else { return nil }
            return String(text[range])
        }
    }

    /// Every match's capture groups.
    public static func matches(_ text: String, _ pattern: String, options: NSRegularExpression.Options = []) -> [[String?]] {
        guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { return [] }
        return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { m in
            (0..<m.numberOfRanges).map { i in
                let r = m.range(at: i)
                guard r.location != NSNotFound, let range = Range(r, in: text) else { return nil }
                return String(text[range])
            }
        }
    }
}
