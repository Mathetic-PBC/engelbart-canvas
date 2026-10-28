import Foundation
import EngelbartDoc

// The words post-its put on things: +Note's name (main/post-its/views.cjs noteName) and the trash panel's lines
// (post-its/TrashPanel.jsx timeLeft, preview). Lengths are UTF-16, as JavaScript counts them.

public enum PostItWords {
    private static let fence = Rx(#"^\s*(`{3,}|~{3,})"#)
    private static let marker = Rx(#"^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+\[[ xX]?\]\s*|[-*+]\s+|\d+[.)]\s+)"#)
    private static let picture = Rx(#"!\[([^\]]*)\]\([^)]*\)"#, "g")
    private static let mention = Rx(#"@\[([^\]]*)\]\((?:ws|lib|zotero):[^)\s]*\)"#, "g")
    private static let link = Rx(#"\[([^\]]*)\]\([^)]*\)"#, "g")
    private static let bare = Rx(#"@\[([^\]]*)\]"#, "g")
    private static let emphasis = Rx(#"\*\*|__|~~|`|\*"#, "g")
    private static let spaces = Rx(#"\s+"#, "g")

    /// A note's name from a post-it's first line of words (markdown markers dropped), or nil when it has none.
    public static func noteName(_ text: String) -> String? {
        var fenced = false
        for raw in text.components(separatedBy: "\n") {
            if fence.test(raw) { fenced.toggle(); continue }
            if fenced { continue }
            var line = marker.replace(raw, with: "", global: false)
            line = picture.replace(line, with: "")
            line = mention.replace(line, with: "$1")
            line = link.replace(line, with: "$1")
            line = bare.replace(line, with: "$1")
            line = emphasis.replace(line, with: "")
            line = spaces.replace(line, with: " ").trimmed
            if line.isEmpty { continue }
            if line.len > 60 {
                let cut = line.slice(0, 60), space = cut.lastIndexOf(" ")
                line = (space > 30 ? cut.slice(0, space) : cut).trimmed
            }
            return line
        }
        return nil
    }

    static let DAY: TimeInterval = 24 * 60 * 60

    /// How long a thrown-away card has left, in the words the trash panel uses.
    public static func timeLeft(_ expires: Date, now: Date = Date()) -> String {
        let days = (expires.timeIntervalSince(now) / DAY).rounded(.up)
        if !(days > 1) { return "deleted within a day" }
        return "deleted in \(Int(days)) days"
    }

    private static let listMarker = Rx(#"^\s*(?:#{1,6}\s+|[-*+]\s+\[[ xX]?\]\s*|[-*+]\s+|>\s*)"#)
    private static let marks = Rx(#"\*\*|`|\*"#, "g")

    /// A card's first lines as plain words, for the trash panel's list.
    public static func preview(_ text: String) -> String {
        let lines = text.components(separatedBy: "\n")
            .map { marks.replace(listMarker.replace($0, with: "", global: false), with: "").trimmed }
            .filter { !$0.isEmpty }
        return lines.prefix(3).joined(separator: " · ")
    }

    /// An ISO-8601 time as main writes them (milliseconds, Z), or nil.
    static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }

    static func iso(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }

    /// A link clicked on a card goes to the Stage (ipc-validation.cjs parseExternalUrl): http or https only, ≤ 4096
    /// characters; the address as the URL parser writes it (a bare host gains its "/").
    public static func externalURL(_ value: String) throws -> String {
        guard !value.isEmpty, value.len <= 4096 else { throw GeometryError("URL must be a bounded string") }
        guard let url = URL(string: value), let scheme = url.scheme?.lowercased() else { throw GeometryError("URL is invalid") }
        guard scheme == "http" || scheme == "https" else { throw GeometryError("URL protocol must be http or https") }
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.host?.isEmpty == false else { throw GeometryError("URL is invalid") }
        parts.scheme = scheme
        parts.host = parts.host?.lowercased()
        if parts.percentEncodedPath.isEmpty { parts.percentEncodedPath = "/" }
        return parts.string ?? value
    }
}
