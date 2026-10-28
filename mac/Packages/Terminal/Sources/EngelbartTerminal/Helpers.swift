import Foundation

// Port of src/renderer/terminal/helpers.cjs (the Experimental Terminal's renderer helpers) plus `estimateDimensions`
// from sessions.js. Pure functions, unit-tested as the Electron ones are (test/renderer-helpers.test.cjs).

public enum TerminalHelpers {
    public static let defaultChunkBytes = 48 * 1024

    /// Splits `value` into pieces of at most `maximumBytes` UTF-8 bytes, never inside a Unicode scalar.
    public static func splitUtf8Chunks(_ value: String, maximumBytes: Int = defaultChunkBytes) throws -> [String] {
        guard maximumBytes >= 1 else { throw TerminalError("Chunk size must be a positive integer") }
        if value.isEmpty { return [] }
        var chunks: [String] = []
        var current = String.UnicodeScalarView()
        var currentBytes = 0
        for scalar in value.unicodeScalars {
            let size = scalar.value <= 0x7f ? 1 : scalar.value <= 0x7ff ? 2 : scalar.value <= 0xffff ? 3 : 4
            if size > maximumBytes { throw TerminalError("Chunk limit cannot contain one complete character") }
            if !current.isEmpty && currentBytes + size > maximumBytes {
                chunks.append(String(current))
                current = String.UnicodeScalarView()
                currentBytes = 0
            }
            current.append(scalar)
            currentBytes += size
        }
        if !current.isEmpty { chunks.append(String(current)) }
        return chunks
    }

    /// A key as the helpers look at it (a DOM KeyboardEvent's fields; the pane fills it from an NSEvent).
    public struct Key: Equatable, Sendable {
        public var key: String
        public var shift = false, alt = false, ctrl = false, meta = false
        public var composing = false
        public init(key: String, shift: Bool = false, alt: Bool = false, ctrl: Bool = false, meta: Bool = false, composing: Bool = false) {
            self.key = key; self.shift = shift; self.alt = alt; self.ctrl = ctrl; self.meta = meta; self.composing = composing
        }
    }

    public enum KeyAction: Equatable, Sendable { case lineFeed, copy }

    /// Only plain Shift+Enter (a line feed for Claude Code's multi-line input) and ⌘C are the terminal's own.
    public static func terminalKeyAction(_ event: Key?) -> KeyAction? {
        guard let event, !event.composing else { return nil }
        if event.key == "Enter" && event.shift && !event.alt && !event.ctrl && !event.meta { return .lineFeed }
        if event.key.lowercased() == "c" && event.meta && !event.alt && !event.ctrl { return .copy }
        return nil
    }

    public enum WorkspaceAction: Equatable, Sendable { case fontIncrease, activateSession(Int), closeFind }

    /// Experimental Terminal's workspace shortcuts (kept with their tests; the Engelbart pane uses ⌘1–9 itself).
    public static func workspaceKeyAction(_ event: Key?, dialogOpen: Bool = false, findOpen: Bool = false) -> WorkspaceAction? {
        guard let event, !dialogOpen else { return nil }
        if event.meta && !event.alt && !event.ctrl && event.key == "+" { return .fontIncrease }
        if event.meta && !event.alt && !event.ctrl, event.key.count == 1, let digit = Int(event.key), (1...9).contains(digit) {
            return .activateSession(digit - 1)
        }
        if event.key == "Escape" && findOpen { return .closeFind }
        return nil
    }

    public static func initialTerminalGeometry(cols: Int?, rows: Int?) throws -> (cols: Int, rows: Int) {
        guard let cols, let rows, (2...500).contains(cols), (1...500).contains(rows) else {
            throw TerminalError("Snapshot dimensions are invalid")
        }
        return (cols, rows)
    }

    static let chromeFocusActions: Set<String> = ["tab", "tab-close", "sidebar", "sidebar-close"]

    public static func preservedChromeFocus(sessionId: String?, action: String?, sessionIds: [String]) -> (sessionId: String, action: String)? {
        guard let sessionId, let action, chromeFocusActions.contains(action), sessionIds.contains(sessionId) else { return nil }
        return (sessionId, action)
    }

    /// A terminal link opens as a new tab on the Stage, which takes web pages only: the href, normalized as a browser's
    /// URL parser would (`http://localhost:5173` → `http://localhost:5173/`), or the Electron error.
    public static func browserLink(_ uri: String) throws -> String {
        guard let components = URLComponents(string: uri.trimmingCharacters(in: .whitespaces)), let scheme = components.scheme else {
            throw TerminalError("URL is invalid")
        }
        let lower = scheme.lowercased()
        guard lower == "http" || lower == "https" else { throw TerminalError("URL protocol must be http or https") }
        guard let host = components.host, !host.isEmpty else { throw TerminalError("URL is invalid") }
        var normalized = components
        normalized.scheme = lower
        normalized.host = host.lowercased()
        if (lower == "http" && normalized.port == 80) || (lower == "https" && normalized.port == 443) { normalized.port = nil }
        if normalized.path.isEmpty { normalized.path = "/" }
        guard let href = normalized.string else { throw TerminalError("URL is invalid") }
        return href
    }

    /// cols/rows a stage of `size` holds at `fontSize` before the PTY exists (Experimental Terminal estimateDimensions);
    /// nil size = 800 × 300.
    public static func estimateDimensions(size: CGSize?, fontSize: Double) -> (cols: Int, rows: Int) {
        let bounds = size ?? CGSize(width: 800, height: 300)
        let cols = max(20, min(500, Int(((Double(bounds.width) - 24) / (fontSize * 0.61)).rounded(.down))))
        let rows = max(5, min(500, Int(((Double(bounds.height) - 18) / (fontSize * 1.2)).rounded(.down))))
        return (cols, rows)
    }
}

/// Suppresses the one echo of a shortcut that arrives from a second source (menu and renderer) within `window`.
public final class CrossSourceShortcutGate {
    public let windowMs: Double
    private var last: (action: String, source: String, now: Double)?
    public init(windowMs: Double = 100) { self.windowMs = windowMs }

    public func allow(_ action: String, source: String, now: Double) -> Bool {
        if let last, last.action == action, last.source != source, now >= last.now, now - last.now <= windowMs { return false }
        last = (action, source, now)
        return true
    }
}

/// Output and exits for sessions not yet adopted, merged with a snapshot's history by sequence (live entries win),
/// bounded by count and bytes. In the native app adoption reads the history and subscribes in one main-thread step, so
/// nothing is ever pending; the type is kept, with its tests, as the record of the Electron rule.
public final class PendingEvents {
    public struct Entry: Equatable, Sendable {
        public var id: String
        public var sequence: Int
        public var data: String
        public init(id: String, sequence: Int, data: String) { self.id = id; self.sequence = sequence; self.data = data }
    }

    public let maxEntries: Int
    public let maxBytes: Int
    private var entries: [String: [Int: (entry: Entry, bytes: Int, serial: Int)]] = [:]
    private var order: [(id: String, sequence: Int, serial: Int)] = []
    private var exits: [String: SessionExit] = [:]
    private var entryCount = 0
    private var bytes = 0
    private var serial = 0

    public init(maxEntries: Int = 1200, maxBytes: Int = 2 * 1024 * 1024) { self.maxEntries = maxEntries; self.maxBytes = maxBytes }

    /// → what was dropped to stay within the bounds (to be acknowledged).
    @discardableResult
    public func pushData(_ payload: Entry) -> [Entry] {
        guard payload.sequence >= 1 else { return [] }
        if entries[payload.id]?[payload.sequence] != nil { return [] }
        serial += 1
        let size = payload.data.utf8.count
        entries[payload.id, default: [:]][payload.sequence] = (payload, size, serial)
        order.append((payload.id, payload.sequence, serial))
        entryCount += 1
        bytes += size
        var dropped: [Entry] = []
        while entryCount > maxEntries || bytes > maxBytes {
            guard !order.isEmpty else { break }
            let oldest = order.removeFirst()
            guard let stored = entries[oldest.id]?[oldest.sequence], stored.serial == oldest.serial else { continue }
            entries[oldest.id]?[oldest.sequence] = nil
            if entries[oldest.id]?.isEmpty == true { entries[oldest.id] = nil }
            entryCount -= 1
            bytes -= stored.bytes
            dropped.append(stored.entry)
        }
        return dropped
    }

    public func pushExit(_ payload: SessionExit) { exits[payload.id] = payload }

    public func take(_ id: String, history: [HistoryEntry] = []) -> (data: [HistoryEntry], exit: SessionExit?) {
        var merged: [Int: HistoryEntry] = [:]
        for entry in history { merged[entry.sequence] = entry }
        if let sessionEntries = entries[id] {
            for (_, stored) in sessionEntries {
                merged[stored.entry.sequence] = HistoryEntry(sequence: stored.entry.sequence, data: stored.entry.data)
                entryCount -= 1
                bytes -= stored.bytes
            }
            entries[id] = nil
            order.removeAll { $0.id == id }
        }
        let exit = exits.removeValue(forKey: id)
        return (merged.values.sorted { $0.sequence < $1.sequence }, exit)
    }
}
