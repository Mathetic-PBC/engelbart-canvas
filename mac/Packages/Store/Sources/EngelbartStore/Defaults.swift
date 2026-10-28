import Foundation
import EngelbartCore

/// Defaults that reach existing installs (defaults.cjs, 2026-09-23; design D1–D3). Each file Engelbart writes defaults into
/// keeps, in `<dir>/.defaults/<name>`, the defaults it was last given (the base). At load, a value still equal to the base
/// moves to the new default; a value that differs is the person's and stays; a key they deleted stays deleted; a key only
/// the new defaults have is added; a key the new defaults dropped goes unless they changed it. Arrays are one value each.
/// The three-way merge dpkg/ucf apply to configuration files, the person winning every conflict. `nil` is "absent".
public enum Defaults {
    /// Same JSON value, whatever the key order; absent differs from null.
    public static func equal(_ a: JSONValue?, _ b: JSONValue?) -> Bool { a == b }

    static func valueAt(_ object: JSONValue?, _ key: String) -> JSONValue? {
        guard case .object(let o)? = object else { return nil }
        return o[key]
    }

    /// base: the defaults last given; ours: the file now; theirs: the defaults now.
    public static func merge3(_ base: JSONValue?, _ ours: JSONValue?, _ theirs: JSONValue?) -> JSONValue? {
        if equal(ours, base) { return theirs }
        if equal(theirs, base) { return ours }
        if case .object(let t)? = theirs, case .object(let o)? = ours, case .object? = base {
            var out: [String: JSONValue] = [:]
            for key in Set(t.keys).union(o.keys) {
                if let merged = merge3(valueAt(base, key), o[key], t[key]) { out[key] = merged }
            }
            return .object(out)
        }
        return ours
    }

    /// The base a file would have had, rebuilt from `versions` (every default ever shipped, oldest first; nil where one
    /// lacked it). Only versions that had the enclosing object are asked about its keys.
    public static func rebuildBase(_ ours: JSONValue?, _ versions: [JSONValue?]) -> JSONValue? {
        let had = versions.compactMap { $0 }
        if had.isEmpty { return nil }
        guard let ours else { return had.count == versions.count ? had.last : nil }
        if had.contains(where: { $0 == ours }) { return ours }
        let objects = had.filter(\.isPlainObject)
        if case .object(let o) = ours, !objects.isEmpty {
            var keys: [String] = []
            for value in objects { for key in value.object!.keys where !keys.contains(key) { keys.append(key) } }
            for key in o.keys where !keys.contains(key) { keys.append(key) }
            var out: [String: JSONValue] = [:]
            for key in keys {
                if let base = rebuildBase(o[key], objects.map { valueAt($0, key) }) { out[key] = base }
            }
            return .object(out)
        }
        return had.last
    }

    /// `ours` with every key `theirs` has and it lacks put back, at every depth.
    static func fill(_ ours: JSONValue, _ theirs: JSONValue) -> JSONValue {
        guard case .object(var o) = ours, case .object(let t) = theirs else { return ours }
        for (key, value) in t { o[key] = o[key].map { fill($0, value) } ?? value }
        return .object(o)
    }

    /// Where a file's base lives: `<dir>/.defaults/<name>`.
    public static func baseFile(for file: String) -> String {
        Paths.join(Paths.dirname(file), ".defaults", Paths.basename(file))
    }

    enum Read { case missing, broken, value(JSONValue) }
    static func readFile(_ path: String) -> Read {
        guard let data = FileManager.default.contents(atPath: path) else {
            return Paths.exists(path) ? .broken : .missing
        }
        guard let value = try? JSONValue.parse(data) else { return .broken }
        return .value(value)
    }

    static func writeFile(_ path: String, _ value: JSONValue) throws {
        try JSONFiles.makeDir(Paths.dirname(path))
        try JSONFiles.write(path, value)
    }

    /// The file's settings, with every default the person left alone brought up to `defaults`, written back when that
    /// changed anything. → (value, wrote); value is nil when the file exists but is not a JSON object (nothing written).
    @discardableResult
    public static func carryDefaults(file: String, defaults: JSONValue, past: [JSONValue] = [], normalize: (JSONValue) -> JSONValue = { $0 },
                                     fillMissing: Bool = false, baseFile: String? = nil, backupDir: String? = nil,
                                     now: () -> Date = Date.init) -> (value: JSONValue?, wrote: Bool) {
        let baseFile = baseFile ?? Self.baseFile(for: file)
        let current: JSONValue
        switch readFile(file) {
        case .missing:
            let value = normalize(defaults)
            try? writeFile(file, value)
            try? writeFile(baseFile, defaults)
            return (value, true)
        case .broken: return (nil, false)
        case .value(let v): current = v
        }
        guard current.isPlainObject else { return (nil, false) }
        var stored: JSONValue?
        if case .value(let v) = readFile(baseFile), v.isPlainObject { stored = v }
        let upToDate = stored != nil && stored == defaults
        var next: JSONValue = upToDate ? current
            : (merge3(stored ?? rebuildBase(current, past.map { Optional($0) } + [defaults]), current, defaults) ?? current)
        if fillMissing { next = fill(next, defaults) }
        if upToDate && next == current { return (current, false) }
        let value = normalize(next)
        let changed = value != current
        if changed {
            if stored == nil, let backupDir {
                // the merge only moves values nobody chose; it still runs when the copy cannot be made
                try? JSONFiles.makeDir(backupDir)
                let stamp = Time.iso(now()).replacingOccurrences(of: ":", with: "-").replacingOccurrences(of: ".", with: "-")
                let stem = (Paths.basename(file) as NSString).deletingPathExtension
                try? FileManager.default.copyItem(atPath: file, toPath: Paths.join(backupDir, "\(stem)-\(stamp).json"))
            }
            try? writeFile(file, value)
        }
        if !upToDate { try? writeFile(baseFile, defaults) }
        return (value, changed)
    }
}
