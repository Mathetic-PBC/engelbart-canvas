import Foundation

// Port of src/main/shell-history.cjs. The terminal pane's box recalls commands with ↑/↓ like a shell. It is seeded from
// the shell's own history file, read here (tail only), so yesterday's commands are there on the first ↑. Nothing leaves
// the machine; the list lives in the pane's memory. (Electron: IPC `engelbart:shell-history`.)

public enum ShellHistory {
    static let tailBytes = 512 * 1024
    static let maxEntry = 2000

    /// zsh writes its history "metafied": a byte 0x83 means "the next byte, xor 0x20".
    public static func unmetafy(_ bytes: [UInt8]) -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(bytes.count)
        var i = 0
        while i < bytes.count {
            if bytes[i] == 0x83 && i + 1 < bytes.count { i += 1; out.append(bytes[i] ^ 0x20) } else { out.append(bytes[i]) }
            i += 1
        }
        return out
    }

    /// Commands from history text, oldest first, duplicates collapsed onto their latest use.
    public static func parse(_ text: String, limit: Int = 300) -> [String] {
        var entries: [String] = []
        var pending: String?
        // `String.split('\n')` keeps empty pieces, as JavaScript's split does.
        for raw in text.components(separatedBy: "\n") {
            var line = raw
            if let before = pending { line = before + "\n" + raw; pending = nil }
            if line.hasSuffix("\\") { pending = String(line.dropLast()); continue }
            var command = line
            if let range = command.range(of: #"^: \d+:\d+;"#, options: .regularExpression) { command.removeSubrange(range) }
            command = trimJS(command)
            if !command.isEmpty && command.utf16.count <= maxEntry { entries.append(command) }
        }
        var seen = Set<String>()
        var out: [String] = []
        var i = entries.count - 1
        while i >= 0 && out.count < limit {
            if !seen.contains(entries[i]) { seen.insert(entries[i]); out.append(entries[i]) }
            i -= 1
        }
        return out.reversed()
    }

    /// `String.prototype.trim`: whitespace and line terminators at both ends.
    static func trimJS(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The tail of the first readable history file: $HISTFILE, ~/.zsh_history, ~/.zhistory, ~/.bash_history.
    public static func read(homeDir: String, environment: [String: String] = ProcessInfo.processInfo.environment, limit: Int = 300) -> [String] {
        let candidates = [environment["HISTFILE"], (homeDir as NSString).appendingPathComponent(".zsh_history"),
                          (homeDir as NSString).appendingPathComponent(".zhistory"), (homeDir as NSString).appendingPathComponent(".bash_history")]
            .compactMap { $0 }.filter { !$0.isEmpty }
        for file in candidates {
            guard let handle = FileHandle(forReadingAtPath: file) else { continue }
            defer { try? handle.close() }
            do {
                let size = try handle.seekToEnd()
                let length = min(size, UInt64(tailBytes))
                try handle.seek(toOffset: size - length)
                let data = try handle.read(upToCount: Int(length)) ?? Data()
                var text = String(decoding: unmetafy([UInt8](data)), as: UTF8.self)
                if length < size { // drop the partial first line
                    if let nl = text.firstIndex(of: "\n") { text = String(text[text.index(after: nl)...]) }
                }
                return parse(text, limit: limit)
            } catch {
                continue // try the next candidate
            }
        }
        return []
    }
}
