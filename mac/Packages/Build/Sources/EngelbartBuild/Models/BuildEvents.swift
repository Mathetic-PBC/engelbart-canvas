import Foundation
import EngelbartCore

/// One event of a repository's sandbox run as the timeline reads it (canvas-build.js buildEvents output).
public struct RunEvent: Equatable, Sendable {
    public var id: JSONValue
    public var seq: Int
    public var runId: String?
    public var at: String?
    public var text: String
    public var kind: String
    public var data: [String: JSONValue]
    public init(id: JSONValue = .null, seq: Int = 0, runId: String? = nil, at: String? = nil, text: String, kind: String = "status", data: [String: JSONValue] = [:]) {
        self.id = id; self.seq = seq; self.runId = runId; self.at = at; self.text = text; self.kind = kind; self.data = data
    }
    func d(_ key: String) -> JSONValue? { data[key] }
    func ds(_ key: String) -> String? { data[key]?.string }
}

/// renderer/model/build-events.js (ported from divadbaroon/engelbart-web @ afd4af9).
public enum BuildEvents {
    public static let statusLabel: [String: String] = [
        "queued": "Waiting for a runner…", "creating": "Creating sandbox…", "cloning": "Cloning…", "cloned": "Cloned. Starting the application…",
        "paused": "Cloned, sandbox paused", "launching": "Starting the application…", "running": "Running", "usable": "Set up and ready to use",
        "no_service": "Nothing to serve", "failed": "Failed", "killed": "Stopped",
    ]
    static let vendor = try! NSRegularExpression(pattern: #":\s*\[[^\]]{0,40}\]|(?:^|\s)This error is likely due to"#)

    public static func plainError(_ error: String?) -> String {
        let said = (error ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if said.isEmpty { return "" }
        var head = said
        if let m = vendor.firstMatch(in: said, range: NSRange(said.startIndex..., in: said)), m.range.location > 0 {
            head = String((said as NSString).substring(to: m.range.location)).replacingOccurrences(of: #"[\s:;,-]+$"#, with: "", options: .regularExpression)
        }
        return head.range(of: "[.!?]$", options: .regularExpression) != nil ? head : "\(head)."
    }

    public static func mergeEvents(_ existing: [RunEvent], _ incoming: [RunEvent]) -> [RunEvent] {
        var bySeq: [Int: RunEvent] = [:]
        var order: [Int] = []
        for e in existing + incoming { if bySeq[e.seq] == nil { order.append(e.seq) }; bySeq[e.seq] = e }
        return order.sorted().map { bySeq[$0]! }
    }

    public struct Line: Equatable, Sendable { public var kind: String; public var text: String }

    /// Plain log output, not a terminal emulator: CR replaces a progress frame, color/erase escapes removed, streams and
    /// stages never joined.
    public static func terminalLines(_ events: [RunEvent]) -> [Line] {
        var lines: [Line] = []
        var open: Int? = nil
        var replace = false
        var stage: String?, phase: String?
        var first = true
        for e in events {
            let stream = e.kind == "stdout" || e.kind == "stderr"
            if !stream || open.map({ lines[$0].kind }) != e.kind || (!first && (stage != e.ds("stage") || phase != e.ds("phase"))) { open = nil; replace = false }
            first = false
            stage = e.ds("stage"); phase = e.ds("phase")
            if e.kind == "metrics" { continue }
            let text = e.text.replacingOccurrences(of: "\u{1b}\\[[0-9;]*[mK]", with: "", options: .regularExpression)
            var i = text.startIndex
            var part = ""
            func flushPart() {
                guard !part.isEmpty else { return }
                if let o = open { lines[o].text = replace ? part : lines[o].text + part }
                else { lines.append(Line(kind: e.kind, text: part)); open = lines.count - 1 }
                replace = false
                part = ""
            }
            while i < text.endIndex {
                let ch = text[i]
                if ch == "\r\n" || ch == "\n" {
                    flushPart()
                    if open == nil { lines.append(Line(kind: e.kind, text: "")) }
                    open = nil; replace = false
                } else if ch == "\r" {
                    flushPart()
                    replace = true // deferred until more text arrives
                } else { part.append(ch) }
                i = text.index(after: i)
            }
            flushPart()
            if !stream { open = nil; replace = false }
        }
        return lines
    }
}
