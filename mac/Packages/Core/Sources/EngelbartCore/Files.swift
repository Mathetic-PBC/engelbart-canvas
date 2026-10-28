import Foundation

public enum Files {
    /// Writes through a temporary file in the same directory and renames it over the target, so a reader never sees a
    /// half-written file (the Electron store's write-then-rename).
    public static func writeAtomically(_ data: Data, to url: URL, mode: Int16? = nil) throws {
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString.prefix(8)).tmp")
        try data.write(to: tmp)
        if let mode { chmod(tmp.path, mode_t(mode)) }
        if rename(tmp.path, url.path) != 0 {
            let err = errno
            try? FileManager.default.removeItem(at: tmp)
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(err))
        }
    }

    public static func writeAtomically(_ text: String, to url: URL, mode: Int16? = nil) throws {
        try writeAtomically(Data(text.utf8), to: url, mode: mode)
    }

    public static func readJSON(_ url: URL) -> JSONValue? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONValue.parse(data)
    }

    /// `JSON.stringify(value, null, 2) + '\n'`, the Electron files' format.
    public static func writeJSON(_ value: JSONValue, to url: URL) throws {
        try writeAtomically(value.text(pretty: true) + "\n", to: url)
    }

    public static func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

    public static func isDirectory(_ url: URL) -> Bool {
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &dir) && dir.boolValue
    }

    /// APFS copy-on-write clone of a file or a directory tree (`cp -cR`), falling back to a plain copy.
    public static func cloneItem(at source: URL, to destination: URL) throws {
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        if clonefile(source.path, destination.path, 0) == 0 { return }
        try FileManager.default.copyItem(at: source, to: destination)
    }
}

public enum IDs {
    /// A new lowercase UUID, the form every Electron id has (`crypto.randomUUID()`).
    public static func new() -> String { UUID().uuidString.lowercased() }
}

public enum Time {
    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// `new Date().toISOString()`: `2026-10-28T17:04:05.123Z`.
    public static func iso(_ date: Date = Date()) -> String { formatter.string(from: date) }

    public static func parse(_ text: String) -> Date? { formatter.date(from: text) ?? plain.date(from: text) }

    /// Milliseconds since 1970, JavaScript's `Date.now()`.
    public static func ms(_ date: Date = Date()) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }
}

/// Runs the last call after `delay` of quiet (the editor's 400 ms autosave, the sidebar's search).
public final class Debouncer: @unchecked Sendable {
    private let delay: TimeInterval
    private let queue: DispatchQueue
    private var work: DispatchWorkItem?
    private let lock = NSLock()

    public init(delay: TimeInterval, queue: DispatchQueue = .main) { self.delay = delay; self.queue = queue }

    public func call(_ action: @escaping () -> Void) {
        lock.lock()
        work?.cancel()
        let item = DispatchWorkItem(block: action)
        work = item
        lock.unlock()
        queue.asyncAfter(deadline: .now() + delay, execute: item)
    }

    /// Runs a pending call now (flush on close/quit).
    public func flush() {
        lock.lock(); let item = work; work = nil; lock.unlock()
        guard let item, !item.isCancelled else { return }
        item.cancel()
        item.perform()
    }

    public func cancel() { lock.lock(); work?.cancel(); work = nil; lock.unlock() }
}
