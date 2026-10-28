import Foundation
import EngelbartCore

// Reading the snapshots main sends (connect/session.cjs publicState, discovery, providers, browsers, the tool check) the
// way the renderer read them: a missing field is '' / 0 / false / [], and truthiness is JavaScript's.

enum J {
    /// `value || ''` for a string field; numbers are not strings (main never sends one where a string is read).
    static func str(_ value: JSONValue?) -> String { value?.string ?? "" }
    /// `value || 0`.
    static func num(_ value: JSONValue?) -> Double { value?.double ?? 0 }
    static func int(_ value: JSONValue?) -> Int { Int(num(value)) }
    static func arr(_ value: JSONValue?) -> [JSONValue] { value?.array ?? [] }
    static func strs(_ value: JSONValue?) -> [String] { arr(value).compactMap(\.string) }
    /// JavaScript's `!!value`.
    static func truthy(_ value: JSONValue?) -> Bool {
        guard let value else { return false }
        switch value {
        case .null: return false
        case .bool(let b): return b
        case .number(let n): return n != 0 && !n.isNaN
        case .string(let s): return !s.isEmpty
        case .array, .object: return true
        }
    }
    /// The value when truthy, else nil (`value || null`). A closure `{ truthy($0) ? $0 : nil }` would not do: JSONValue is
    /// ExpressibleByNilLiteral, so its `nil` is `.null` and the optional stays `.some(.null)`.
    static func present(_ value: JSONValue) -> JSONValue? { truthy(value) ? value : Optional<JSONValue>.none }
    /// `value === true`.
    static func isTrue(_ value: JSONValue?) -> Bool { value?.bool == true }
}

extension JSONValue {
    /// A copy with `key` set (objects only; anything else becomes an object holding it).
    func with(_ key: String, _ value: JSONValue?) -> JSONValue {
        var object = self.object ?? [:]
        object[key] = value
        return .object(object)
    }
}

/// "a", "a and b", "a, b and c" (connect.js `listed`, `andList`).
func listed(_ names: [String]) -> String {
    if names.count < 2 { return names.joined() }
    return names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
}

/// The renderer's tidy error: "Error invoking remote method 'x': Error: why" → "why".
public func tidyError(_ failure: Error) -> String {
    tidyError((failure as? LocalizedError)?.errorDescription ?? String(describing: failure))
}

public func tidyError(_ text: String) -> String {
    text.replacingOccurrences(of: #"^Error invoking remote method '[^']+': (\w*Error: )?"#, with: "", options: .regularExpression)
}

/// A reason's first sentence (split after . ! ?), at most `max` characters.
func firstSentence(_ text: String, max: Int = 160) -> String {
    let one = text.components(separatedBy: CharacterSet.newlines).joined(separator: " ")
    var out = one
    if let range = one.range(of: #"(?<=[.!?])\s"#, options: .regularExpression) { out = String(one[..<range.lowerBound]) }
    return String(out.prefix(max))
}
