import Foundation
import EngelbartDoc

// store/defaults.cjs, over ordered JSON, for the one file this package owns (model-effort-inline-question.json): the
// Store package owns the same rule for config.json, but a wave-1 package cannot depend on Store and the models file needs
// its key order kept, so the merge is ported here too.
//
// Each such file keeps, in <home>/.defaults/, the defaults it was last given: the base. At load, a value still equal to
// the base was left alone and moves to the new default; a value that differs is the person's and stays; a key they
// deleted stays deleted; a key only the new defaults have is added; a key the new defaults dropped goes unless they
// changed it. Arrays are one value each. A file written before there were bases gets one rebuilt from every default
// ever shipped (`past`). Its first rewrite keeps a copy in <home>/.backups/. A file that does not parse is never written.

public enum CarryDefaults {
    /// base: the defaults last given; ours: the file now; theirs: the defaults now. nil = absent.
    public static func merge3(_ base: OJ?, _ ours: OJ?, _ theirs: OJ?) -> OJ? {
        if eq(ours, base) { return theirs }
        if eq(theirs, base) { return ours }
        if let b = base, b.isObject, let o = ours, o.isObject, let t = theirs, t.isObject {
            var out: [(String, OJ)] = []
            var keys = t.keys
            for k in o.keys where !keys.contains(k) { keys.append(k) }
            for k in keys {
                if let merged = merge3(b[k], o[k], t[k]) { out.append((k, merged)) }
            }
            return .object(out)
        }
        return ours
    }

    static func eq(_ a: OJ?, _ b: OJ?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case (let x?, let y?): return jsonEqual(x, y)
        default: return false
        }
    }

    /// The base a file would have had, rebuilt from `versions` (the value at this place in every default ever shipped,
    /// oldest first; nil where one lacked it).
    public static func rebuildBase(_ ours: OJ?, _ versions: [OJ?]) -> OJ? {
        let had = versions.compactMap { $0 }
        if had.isEmpty { return nil }
        guard let ours else { return had.count == versions.count ? had.last : nil }
        if had.contains(where: { jsonEqual($0, ours) }) { return ours }
        let objects = had.filter { $0.isObject }
        if ours.isObject && !objects.isEmpty {
            var keys: [String] = []
            for o in objects { for k in o.keys where !keys.contains(k) { keys.append(k) } }
            for k in ours.keys where !keys.contains(k) { keys.append(k) }
            var out: [(String, OJ)] = []
            for k in keys {
                if let base = rebuildBase(ours[k], objects.map { $0[k] }) { out.append((k, base)) }
            }
            return .object(out)
        }
        return had.last
    }

    /// `ours` with every key `theirs` has and it lacks put back, at every depth.
    static func fill(_ ours: OJ, _ theirs: OJ) -> OJ {
        guard ours.isObject, let t = theirs.pairs else { return ours }
        var out = ours
        for (k, v) in t { out = out.setting(k, ours[k].map { fill($0, v) } ?? v) }
        return out
    }

    public static func baseFile(for file: URL) -> URL {
        file.deletingLastPathComponent().appendingPathComponent(".defaults").appendingPathComponent(file.lastPathComponent)
    }

    enum Read { case missing, broken, value(OJ) }

    static func readFile(_ url: URL) -> Read {
        guard let data = FileManager.default.contents(atPath: url.path) else {
            return FileManager.default.fileExists(atPath: url.path) ? .broken : .missing
        }
        return OJ.parse(data).map(Read.value) ?? .broken
    }

    /// The file's settings, with every default the person left alone brought up to `defaults`, written back when that
    /// changed anything. → (value, wrote); value nil when the file exists but is not a JSON object.
    @discardableResult
    public static func carry(file: URL, defaults: OJ, past: [OJ] = [], normalize: (OJ) -> OJ = { $0 }, fillMissing: Bool = false,
                             baseFile: URL? = nil, backupDir: URL? = nil, now: Date = Date()) throws -> (value: OJ?, wrote: Bool) {
        let base = baseFile ?? Self.baseFile(for: file)
        let current = readFile(file)
        if case .missing = current {
            let value = normalize(defaults)
            try writeJSONFile(file, value)
            try writeJSONFile(base, defaults)
            return (value, true)
        }
        guard case .value(let held) = current, held.isObject else { return (nil, false) }
        var stored: OJ? = nil
        if case .value(let s) = readFile(base), s.isObject { stored = s }
        let upToDate = stored.map { jsonEqual($0, defaults) } ?? false
        var next: OJ = upToDate ? held : (merge3(stored ?? rebuildBase(held, past.map { Optional($0) } + [defaults]), held, defaults) ?? held)
        if fillMissing { next = fill(next, defaults) }
        if upToDate && jsonEqual(next, held) { return (held, false) }
        let value = normalize(next)
        let changed = !jsonEqual(value, held)
        if changed {
            if stored == nil, let backupDir {
                try? FileManager.default.createDirectory(at: backupDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let stamp = isoStamp(now)
                try? FileManager.default.copyItem(at: file, to: backupDir.appendingPathComponent("\(file.deletingPathExtension().lastPathComponent)-\(stamp).json"))
            }
            try writeJSONFile(file, value)
        }
        if !upToDate { try writeJSONFile(base, defaults) }
        return (value, changed)
    }

    /// `new Date().toISOString().replace(/[:.]/g, '-')`.
    static func isoStamp(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: date).replacingOccurrences(of: ":", with: "-").replacingOccurrences(of: ".", with: "-")
    }
}
