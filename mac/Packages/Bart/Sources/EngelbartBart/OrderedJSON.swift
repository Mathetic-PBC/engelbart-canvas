import Foundation
import EngelbartDoc
import EngelbartCore

/// JSON whose objects keep their keys in order, as a JavaScript object does. The models file needs it: the order of a
/// provider's `models` is their rank (question.cjs `above`: Haiku first ranks lowest), and the files Engelbart writes
/// (`JSON.stringify(value, null, 2)`) keep the order they were built in. Core's `JSONValue` is a dictionary, so it is
/// converted to and from at the package's edge.
public indirect enum OJ: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([OJ])
    case object([(String, OJ)])

    public static func == (a: OJ, b: OJ) -> Bool { jsonEqual(a, b) }

    public subscript(key: String) -> OJ? {
        if case .object(let pairs) = self { return pairs.first(where: { $0.0 == key })?.1 }
        return nil
    }

    public var string: String? { if case .string(let s) = self { return s }; return nil }
    public var double: Double? { if case .number(let n) = self { return n }; return nil }
    public var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var array: [OJ]? { if case .array(let a) = self { return a }; return nil }
    public var pairs: [(String, OJ)]? { if case .object(let o) = self { return o }; return nil }
    public var isObject: Bool { if case .object = self { return true }; return false }
    public var keys: [String] { pairs?.map { $0.0 } ?? [] }

    /// The object with `key` set (kept in place when present, appended when not).
    public func setting(_ key: String, _ value: OJ) -> OJ {
        guard case .object(var pairs) = self else { return .object([(key, value)]) }
        if let i = pairs.firstIndex(where: { $0.0 == key }) { pairs[i].1 = value } else { pairs.append((key, value)) }
        return .object(pairs)
    }

    public func removing(_ key: String) -> OJ {
        guard case .object(let pairs) = self else { return self }
        return .object(pairs.filter { $0.0 != key })
    }

    // MARK: conversion

    public init(_ value: JSONValue) {
        switch value {
        case .null: self = .null
        case .bool(let b): self = .bool(b)
        case .number(let n): self = .number(n)
        case .string(let s): self = .string(s)
        case .array(let a): self = .array(a.map(OJ.init))
        case .object(let o): self = .object(o.keys.sorted().map { ($0, OJ(o[$0]!)) })
        }
    }

    public var jsonValue: JSONValue {
        switch self {
        case .null: return .null
        case .bool(let b): return .bool(b)
        case .number(let n): return .number(n)
        case .string(let s): return .string(s)
        case .array(let a): return .array(a.map { $0.jsonValue })
        case .object(let o): return .object(Dictionary(o.map { ($0.0, $0.1.jsonValue) }, uniquingKeysWith: { _, b in b }))
        }
    }

    // MARK: text

    /// `JSON.stringify(value)` (indent 0) or `JSON.stringify(value, null, indent)`.
    public func stringify(indent: Int = 0) -> String {
        var out = ""
        write(&out, indent: indent, depth: 0)
        return out
    }

    private func write(_ out: inout String, indent: Int, depth: Int) {
        let pad = { (d: Int) -> String in String(repeating: " ", count: d * indent) }
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .number(let n): out += jsNumber(n)
        case .string(let s): out += jsonQuote(s)
        case .array(let a):
            if a.isEmpty { out += "[]"; return }
            out += "["
            for (i, item) in a.enumerated() {
                if i > 0 { out += "," }
                if indent > 0 { out += "\n" + pad(depth + 1) }
                item.write(&out, indent: indent, depth: depth + 1)
            }
            if indent > 0 { out += "\n" + pad(depth) }
            out += "]"
        case .object(let o):
            if o.isEmpty { out += "{}"; return }
            out += "{"
            for (i, (k, v)) in o.enumerated() {
                if i > 0 { out += "," }
                if indent > 0 { out += "\n" + pad(depth + 1) }
                out += jsonQuote(k) + (indent > 0 ? ": " : ":")
                v.write(&out, indent: indent, depth: depth + 1)
            }
            if indent > 0 { out += "\n" + pad(depth) }
            out += "}"
        }
    }

    /// Parses JSON text keeping key order; nil when it is not JSON. A key given twice keeps its first place and last value.
    public static func parse(_ text: String) -> OJ? {
        var p = OJParser(Array(text.utf16))
        p.skip()
        guard let v = p.value() else { return nil }
        p.skip()
        return p.at == p.s.count ? v : nil
    }

    public static func parse(_ data: Data) -> OJ? { parse(String(decoding: data, as: UTF8.self)) }

    public static func read(_ url: URL) -> OJ? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return parse(data)
    }
}

/// Deep equality whatever the key order (store/defaults.cjs `equal`).
public func jsonEqual(_ a: OJ, _ b: OJ) -> Bool {
    switch (a, b) {
    case (.null, .null): return true
    case (.bool(let x), .bool(let y)): return x == y
    case (.number(let x), .number(let y)): return x == y
    case (.string(let x), .string(let y)): return x == y
    case (.array(let x), .array(let y)): return x.count == y.count && zip(x, y).allSatisfy { jsonEqual($0, $1) }
    case (.object(let x), .object(let y)):
        guard x.count == y.count else { return false }
        for (k, v) in x { guard let w = y.first(where: { $0.0 == k })?.1, jsonEqual(v, w) else { return false } }
        return true
    default: return false
    }
}

/// How JS prints a number in JSON.
func jsNumber(_ n: Double) -> String {
    if !n.isFinite { return "null" }
    if n.rounded() == n && abs(n) < 1e21 { return String(Int64(n)) }
    var s = String(n)
    if s.hasSuffix(".0") { s.removeLast(2) }
    return s
}

/// A string as `JSON.stringify` writes it: `"` and `\` escaped, control characters as \b \f \n \r \t or \u00XX, lone
/// surrogates as \udXXX; everything else as it is (no escaping of `/` or of non-ASCII).
public func jsonQuote(_ s: String) -> String {
    var out = "\""
    let units = Array(s.utf16)
    var i = 0
    while i < units.count {
        let u = units[i]
        switch u {
        case 0x22: out += "\\\""
        case 0x5C: out += "\\\\"
        case 0x08: out += "\\b"
        case 0x0C: out += "\\f"
        case 0x0A: out += "\\n"
        case 0x0D: out += "\\r"
        case 0x09: out += "\\t"
        case 0..<0x20: out += String(format: "\\u%04x", u)
        case 0xD800...0xDBFF:
            if i + 1 < units.count, (0xDC00...0xDFFF).contains(units[i + 1]) {
                out += String(utf16CodeUnits: [u, units[i + 1]], count: 2)
                i += 1
            } else { out += String(format: "\\u%04x", u) }
        case 0xDC00...0xDFFF: out += String(format: "\\u%04x", u)
        default: out += String(utf16CodeUnits: [u], count: 1)
        }
        i += 1
    }
    return out + "\""
}

private struct OJParser {
    let s: [UInt16]
    var at = 0
    init(_ s: [UInt16]) { self.s = s }

    mutating func skip() { while at < s.count, [0x20, 0x09, 0x0A, 0x0D].contains(s[at]) { at += 1 } }

    mutating func value() -> OJ? {
        skip()
        guard at < s.count else { return nil }
        switch s[at] {
        case 0x7B: return object()
        case 0x5B: return array()
        case 0x22: return str().map(OJ.string)
        case 0x74: return word("true", .bool(true))
        case 0x66: return word("false", .bool(false))
        case 0x6E: return word("null", .null)
        default: return number()
        }
    }

    mutating func word(_ w: String, _ v: OJ) -> OJ? {
        let u = Array(w.utf16)
        guard at + u.count <= s.count, Array(s[at..<at + u.count]) == u else { return nil }
        at += u.count
        return v
    }

    mutating func number() -> OJ? {
        let start = at
        while at < s.count, let c = Unicode.Scalar(s[at]), "+-0123456789.eE".unicodeScalars.contains(c) { at += 1 }
        guard at > start, let n = Double(String(utf16CodeUnits: Array(s[start..<at]), count: at - start)) else { return nil }
        return .number(n)
    }

    mutating func str() -> String? {
        guard at < s.count, s[at] == 0x22 else { return nil }
        at += 1
        var out: [UInt16] = []
        while at < s.count {
            let c = s[at]
            if c == 0x22 { at += 1; return String(decoding: out, as: UTF16.self) }
            if c == 0x5C {
                at += 1
                guard at < s.count else { return nil }
                let e = s[at]
                switch e {
                case 0x22: out.append(0x22)
                case 0x5C: out.append(0x5C)
                case 0x2F: out.append(0x2F)
                case 0x62: out.append(0x08)
                case 0x66: out.append(0x0C)
                case 0x6E: out.append(0x0A)
                case 0x72: out.append(0x0D)
                case 0x74: out.append(0x09)
                case 0x75:
                    guard at + 4 < s.count, let v = UInt16(String(utf16CodeUnits: Array(s[at + 1...at + 4]), count: 4), radix: 16) else { return nil }
                    out.append(v)
                    at += 4
                default: return nil
                }
                at += 1
                continue
            }
            if c < 0x20 { return nil }
            out.append(c)
            at += 1
        }
        return nil
    }

    mutating func array() -> OJ? {
        at += 1
        var items: [OJ] = []
        skip()
        if at < s.count, s[at] == 0x5D { at += 1; return .array([]) }
        while true {
            guard let v = value() else { return nil }
            items.append(v)
            skip()
            guard at < s.count else { return nil }
            if s[at] == 0x2C { at += 1; continue }
            if s[at] == 0x5D { at += 1; return .array(items) }
            return nil
        }
    }

    mutating func object() -> OJ? {
        at += 1
        var pairs: [(String, OJ)] = []
        skip()
        if at < s.count, s[at] == 0x7D { at += 1; return .object([]) }
        while true {
            skip()
            guard let k = str() else { return nil }
            skip()
            guard at < s.count, s[at] == 0x3A else { return nil }
            at += 1
            guard let v = value() else { return nil }
            if let i = pairs.firstIndex(where: { $0.0 == k }) { pairs[i].1 = v } else { pairs.append((k, v)) }
            skip()
            guard at < s.count else { return nil }
            if s[at] == 0x2C { at += 1; continue }
            if s[at] == 0x7D { at += 1; return .object(pairs) }
            return nil
        }
    }
}

extension OJ: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral,
    ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral, ExpressibleByFloatLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(arrayLiteral elements: OJ...) { self = .array(elements) }
    /// Dictionary literals keep their written order.
    public init(dictionaryLiteral elements: (String, OJ)...) { self = .object(elements) }
    public init(nilLiteral: ()) { self = .null }
}

/// `JSON.stringify(value, null, 2) + '\n'` written over a temporary renamed into place, mode 0600 (the Electron
/// store's `writeJsonFile`), directory made 0700.
func writeJSONFile(_ url: URL, _ value: OJ) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    try Files.writeAtomically(value.stringify(indent: 2) + "\n", to: url, mode: 0o600)
}
