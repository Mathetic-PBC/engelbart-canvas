import Foundation
import EngelbartCore

// The ink file as JSON, read and written the way the Electron app does (src/main/store/library.cjs writeJson:
// JSON.stringify, no spaces, at most 20 MiB) so a file written by either app reads the same in the other. Keys come in
// JSON.stringify's order: integer-like keys ascending first, then the rest in the order they were made (Electron's order
// for the fields it writes; anything unknown after them, sorted, since its original order cannot be known).

public enum AnnotationJSONError: Error, LocalizedError, Equatable {
    case tooLarge
    public var errorDescription: String? { "annotations are too large" }
}

/// An ordered JSON value: what JSON.stringify would see.
indirect enum OJSON {
    case null, bool(Bool), number(Double), string(String), array([OJSON]), object([(String, OJSON)])

    init(_ v: JSONValue) {
        switch v {
        case .null: self = .null
        case .bool(let b): self = .bool(b)
        case .number(let n): self = .number(n)
        case .string(let s): self = .string(s)
        case .array(let a): self = .array(a.map(OJSON.init))
        case .object(let o): self = .object(OJSON.jsOrder(o.keys.sorted()).map { ($0, OJSON(o[$0]!)) })
        }
    }

    /// Integer-like keys ("0", "12", never "012" or "-1") first in ascending order, then the rest as given.
    static func jsOrder(_ keys: [String]) -> [String] {
        func index(_ k: String) -> UInt32? {
            guard let n = UInt32(k), n < UInt32.max, String(n) == k else { return nil }
            return n
        }
        let ints = keys.compactMap { k in index(k).map { (k, $0) } }.sorted { $0.1 < $1.1 }.map(\.0)
        return ints + keys.filter { index($0) == nil }
    }

    func write(into out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .number(let n): out += JSNumber.string(n)
        case .string(let s): JSString.quote(s, into: &out)
        case .array(let a):
            out += "["
            for (i, v) in a.enumerated() { if i > 0 { out += "," }; v.write(into: &out) }
            out += "]"
        case .object(let o):
            out += "{"
            for (i, kv) in o.enumerated() {
                if i > 0 { out += "," }
                JSString.quote(kv.0, into: &out); out += ":"; kv.1.write(into: &out)
            }
            out += "}"
        }
    }

    var text: String { var s = ""; write(into: &s); return s }
}

/// Number::toString as ECMAScript defines it (the shortest digits that round-trip; plain notation for 1e-7 < |x| < 1e21).
public enum JSNumber {
    public static func string(_ d: Double) -> String {
        if d.isNaN || d.isInfinite { return "null" } // JSON.stringify
        if d == 0 { return "0" }
        if d < 0 { return "-" + string(-d) }
        // Swift's description is the shortest round-trip form too; take its digits and exponent.
        let desc = "\(d)"
        var mantissa = desc, exp = 0
        if let e = desc.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = String(desc[..<e]); exp = Int(desc[desc.index(after: e)...]) ?? 0
        }
        var digits = mantissa.replacingOccurrences(of: ".", with: "")
        let point = mantissa.firstIndex(of: ".").map { mantissa.distance(from: mantissa.startIndex, to: $0) } ?? mantissa.count
        // value = 0.d1d2… × 10^n
        var n = point + exp
        while digits.hasPrefix("0") && digits.count > 1 { digits.removeFirst(); n -= 1 }
        while digits.hasSuffix("0") && digits.count > 1 { digits.removeLast() }
        let k = digits.count
        if k <= n && n <= 21 { return digits + String(repeating: "0", count: n - k) }
        if 0 < n && n <= 21 { let i = digits.index(digits.startIndex, offsetBy: n); return digits[..<i] + "." + digits[i...] }
        if -6 < n && n <= 0 { return "0." + String(repeating: "0", count: -n) + digits }
        let e = n - 1, sign = e < 0 ? "-" : "+"
        let head = String(digits.first!), rest = String(digits.dropFirst())
        return head + (rest.isEmpty ? "" : "." + rest) + "e" + sign + String(abs(e))
    }
}

/// JSON.stringify's string quoting: `"` `\` and controls escaped (\b \f \n \r \t, else \u00xx), lone surrogates as \uXXXX.
enum JSString {
    static func quote(_ s: String, into out: inout String) {
        out += "\""
        let units = Array(s.utf16)
        var i = 0
        let hex = { (v: UInt16) -> String in let h = String(v, radix: 16); return "\\u" + String(repeating: "0", count: 4 - h.count) + h }
        while i < units.count {
            let c = units[i]
            switch c {
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x08: out += "\\b"
            case 0x0C: out += "\\f"
            case 0x0A: out += "\\n"
            case 0x0D: out += "\\r"
            case 0x09: out += "\\t"
            case 0..<0x20: out += hex(c)
            case 0xD800...0xDBFF:
                if i + 1 < units.count, (0xDC00...0xDFFF).contains(units[i + 1]) {
                    out += String(utf16CodeUnits: [c, units[i + 1]], count: 2); i += 1
                } else { out += hex(c) }
            case 0xDC00...0xDFFF: out += hex(c)
            default: out += String(utf16CodeUnits: [c], count: 1)
            }
            i += 1
        }
        out += "\""
    }
}

public enum AnnotationJSON {
    /// 20 MiB, as library.cjs refuses past it.
    public static let maxChars = 20 * 1024 * 1024

    /* ------------------------------------------------------------------------------------------------ reading */

    /// The ink in a file's JSON (anything but an object is no ink: empty).
    public static func decode(_ data: Data) -> PaperMarks {
        guard let v = try? JSONValue.parse(data) else { return PaperMarks() }
        return decode(v)
    }

    public static func decode(_ value: JSONValue?) -> PaperMarks {
        guard let obj = value?.object else { return PaperMarks() }
        var out = PaperMarks()
        for (key, v) in obj {
            if let n = Int(key), String(n) == key, let list = v.array {
                out.pages[n] = list.compactMap(mark)
            } else { out.other[key] = v }
        }
        return out
    }

    static func num(_ v: JSONValue?) -> Double? { v?.double }

    static func rect(_ v: JSONValue) -> PRect? {
        guard let o = v.object else { return nil }
        // A rect missing a coordinate is kept as NaN: mergeLineRects drops it as unusable, as marks.js does.
        return PRect(num(o["x"]) ?? .nan, num(o["y"]) ?? .nan, num(o["w"]) ?? .nan, num(o["h"]) ?? .nan)
    }

    static let markKeys: Set<String> = ["id", "rects", "side", "y", "note", "text", "pos", "group", "w", "asks"]
    static let askKeys: Set<String> = ["id", "question", "answer", "meta", "at", "pos", "collapsed", "crop", "deleted"]

    static func mark(_ v: JSONValue) -> Mark? {
        guard let o = v.object else { return nil }
        let id: String = o["id"]?.string ?? (o["id"]?.double.map { JSNumber.string($0) } ?? "")
        var m = Mark(id: id)
        m.rects = (o["rects"]?.array ?? []).compactMap(rect)
        m.side = o["side"]?.string
        m.y = num(o["y"]) ?? 0
        m.note = o["note"]?.string
        m.text = o["text"]?.string ?? ""
        if let p = o["pos"]?.object, let x = num(p["x"]), let y = num(p["y"]) { m.pos = PPoint(x: x, y: y) }
        m.group = o["group"]?.string
        m.w = num(o["w"])
        if let asks = o["asks"]?.array { m.asks = asks.compactMap(ask) }
        for (k, v) in o where !markKeys.contains(k) { m.extra[k] = v }
        return m
    }

    static func ask(_ v: JSONValue) -> AskEntry? {
        guard let o = v.object else { return nil }
        var a = AskEntry(id: o["id"]?.string ?? "", pos: nil, collapsed: nil)
        a.question = o["question"]?.string
        a.answer = o["answer"]?.string
        a.meta = o["meta"]
        a.at = o["at"]?.string
        a.pos = o["pos"]
        a.collapsed = o["collapsed"]?.bool
        a.crop = o["crop"]?.string
        a.deleted = o["deleted"]?.bool
        for (k, v) in o where !askKeys.contains(k) { a.extra[k] = v }
        return a
    }

    /* ------------------------------------------------------------------------------------------------ writing */

    static func rectJSON(_ r: PRect) -> OJSON { .object([("x", .number(r.x)), ("y", .number(r.y)), ("w", .number(r.w)), ("h", .number(r.h))]) }

    static func markJSON(_ m: Mark) -> OJSON {
        var o: [(String, OJSON)] = [
            ("id", .string(m.id)),
            ("rects", .array(m.rects.map(rectJSON))),
            ("side", m.side.map(OJSON.string) ?? .null),
            ("y", .number(m.y)),
            ("note", m.note.map(OJSON.string) ?? .null),
            ("text", .string(m.text)),
            ("pos", m.pos.map { .object([("x", .number($0.x)), ("y", .number($0.y))]) } ?? .null),
        ]
        if let g = m.group { o.append(("group", .string(g))) }
        if let w = m.w { o.append(("w", .number(w))) }
        if let asks = m.asks { o.append(("asks", .array(asks.map(askJSON)))) }
        for k in m.extra.keys.sorted() { o.append((k, OJSON(m.extra[k]!))) }
        return .object(o)
    }

    static func askJSON(_ a: AskEntry) -> OJSON {
        var o: [(String, OJSON)] = [("id", .string(a.id))]
        if let q = a.question { o.append(("question", .string(q))) }
        if let s = a.answer { o.append(("answer", .string(s))) }
        if let meta = a.meta { o.append(("meta", OJSON(meta))) }
        if let at = a.at { o.append(("at", .string(at))) }
        if let pos = a.pos { o.append(("pos", OJSON(pos))) }
        if let c = a.collapsed { o.append(("collapsed", .bool(c))) }
        if let crop = a.crop { o.append(("crop", .string(crop))) }
        for k in a.extra.keys.sorted() { o.append((k, OJSON(a.extra[k]!))) }
        if let d = a.deleted { o.append(("deleted", .bool(d))) }
        return .object(o)
    }

    static func json(_ marks: PaperMarks) -> OJSON {
        var o: [(String, OJSON)] = marks.pages.keys.sorted().map { (String($0), .array(marks.pages[$0]!.map(markJSON))) }
        for k in OJSON.jsOrder(marks.other.keys.sorted()) { o.append((k, OJSON(marks.other[k]!))) }
        return .object(OJSON.jsOrder(o.map(\.0)).map { k in o.first { $0.0 == k }! })
    }

    /// The ink as JSON.stringify writes it.
    public static func encode(_ marks: PaperMarks) throws -> String {
        let text = json(marks).text
        if text.utf16.count > maxChars { throw AnnotationJSONError.tooLarge }
        return text
    }

    /// The ink as a JSONValue (for hosts that pass ink around as values).
    public static func value(_ marks: PaperMarks) -> JSONValue {
        (try? JSONValue.parse(json(marks).text)) ?? .object([:])
    }
}
