import Foundation

/// JavaScript-style regular expressions over NSRegularExpression (ICU), so the Electron patterns are used as written.
struct Rx {
    let re: NSRegularExpression

    init(_ pattern: String, _ options: NSRegularExpression.Options = []) {
        // The patterns are constants from the source: a bad one is a programming error.
        re = try! NSRegularExpression(pattern: pattern, options: options)
    }

    static func i(_ pattern: String) -> Rx { Rx(pattern, [.caseInsensitive]) }

    func test(_ text: String) -> Bool {
        re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// `exec`: [whole, group1, …] (nil for a group that did not take part), or nil.
    func exec(_ text: String) -> [String?]? {
        guard let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return Rx.groups(m, in: text)
    }

    /// Every match's whole text (`String.prototype.match` with /g).
    func all(_ text: String) -> [String] {
        re.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { m in
            Range(m.range, in: text).map { String(text[$0]) }
        }
    }

    func replace(_ text: String, with template: String) -> String {
        re.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    private static func groups(_ m: NSTextCheckingResult, in text: String) -> [String?] {
        (0..<m.numberOfRanges).map { index in
            let r = m.range(at: index)
            guard r.location != NSNotFound, let range = Range(r, in: text) else { return nil }
            return String(text[range])
        }
    }
}

/// ANSI escapes (CSI and OSC), stripped from what installers and CLIs print.
let ANSI = Rx("\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)")

func stripANSI(_ text: String) -> String { ANSI.replace(text, with: "") }

/// The non-empty trimmed lines of a text, split on \n or \r\n.
func nonEmptyLines(_ text: String) -> [String] {
    text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
}

/// Waits `seconds` (cancellation ends it early). A named function, not a closure literal, as the default `sleep` of the
/// installers and the pretend machine: the closure form crashed the task allocator ("freed pointer was not the last
/// allocation") on Swift 6.3.
@Sendable public func pause(_ seconds: TimeInterval) async {
    guard seconds > 0 else { await Task.yield(); return }
    do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) } catch {}
}

extension String {
    /// `slice(0, n)` by characters.
    func prefixChars(_ n: Int) -> String { String(prefix(max(0, n))) }
}
