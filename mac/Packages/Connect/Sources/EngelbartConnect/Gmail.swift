import Foundation
import EngelbartCore

// Port of src/main/connect/gmail.cjs (Connect your library, 2026-10-11): Gmail, read with the same Google sign-in as
// Google Drive. It is never brought in whole: the librarian searches it, lists the threads that match, and only the ones
// the person approves come in, one note a thread (Tools gmail_accounts, gmail_search, import_gmail_threads).
//
// Checked on a live inbox (2026-10-11): a search lists each thread as a row holding
// <span data-thread-id="#thread-f:<decimal id>" data-legacy-thread-id="<hex id>">; the account's key is the page global
// GLOBALS[9] ("ik"); a whole thread as plain HTML is its print view, ?ik=<ik>&view=pt&search=all&permthid=thread-f:<id>;
// and /mail/u/<n>/ is the account's place in that browser's sign-in order (never assume /u/0).
public enum Gmail {
    public static let threadIdRE = #"^thread-f:\d{1,20}$"#
    public static let ikRE = "^[0-9a-z]{6,20}$"
    public static let maxAccounts = 6
    public static let maxSearch = 50
    public static let maxThreadsACall = 50
    public static let maxThreadsASession = 300
    public static let origin = "https://mail.google.com"

    public static var accountScript: String { Texts.gmailAccountScript }
    public static func searchScript(limit: Int) -> String { Texts.gmailSearchScript.replacingOccurrences(of: "__LIMIT__", with: String(limit)) }

    /// A Gmail account's place in the browser's sign-in order: a whole number 0–9, or an error.
    public static func accountIndex(_ n: JSONValue?) throws -> Int {
        guard let d = n?.double, d.rounded() == d, d >= 0, d <= 9 else { throw ConnectError("failed", "n must be the account's number from gmail_accounts (0–9)") }
        return Int(d)
    }

    /// What a search adds for the session's period: newer_than:1y for a year, newer_than:6m for six months, '' for all time.
    public static func period(_ days: Double?) -> String {
        guard let days, days.isFinite, days > 0 else { return "" }
        if days == 365 { return " newer_than:1y" }
        if days == 182 { return " newer_than:6m" }
        return " newer_than:\(Int(days.rounded(.up)))d"
    }

    public static func inboxUrl(_ n: Int) -> String { "\(origin)/mail/u/\(n)/" }

    /// `encodeURIComponent`.
    public static func encodeURIComponent(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.!~*'()")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    /// The search page for `query` (the period already added).
    public static func searchUrl(_ n: Int, _ query: String) -> String { "\(inboxUrl(n))#search/\(encodeURIComponent(query))" }

    /// A whole thread as plain HTML: its print view.
    public static func printUrl(_ n: Int, ik: String, id: String) throws -> String {
        guard JS.test(ik, ikRE) else { throw ConnectError("failed", "ik must be the account key gmail_search returned") }
        guard JS.test(id, threadIdRE) else { throw ConnectError("failed", "Not a Gmail thread id") }
        return "\(inboxUrl(n))?ik=\(ik)&view=pt&search=all&permthid=\(id)"
    }

    static let entities = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " ", "#39": "'"]

    static func decode(_ text: String) -> String {
        AppleNotes.sub(text, #"&(#x[0-9a-f]+|#\d+|[a-z]+\d*);"#) { g in
            let name = g[1]
            if name.hasPrefix("#") {
                let hex = name.dropFirst().first.map { $0 == "x" || $0 == "X" } ?? false
                let code = UInt32(hex ? String(name.dropFirst(2)) : String(name.dropFirst()), radix: hex ? 16 : 10)
                if let code, code > 0, code < 0x110000, let scalar = Unicode.Scalar(code) { return String(Character(scalar)) }
                return ""
            }
            return entities[name.lowercased()] ?? g[0]
        }
    }

    /// HTML as plain text, its line breaks kept (br, paragraphs, rows, list items), links as Markdown links.
    public static func htmlText(_ html: String) -> String {
        var value = JS.replace(html, #"<!--[\s\S]*?-->"#, "")
        value = JS.replace(value, #"<(script|style|head|title)\b[\s\S]*?</\1>"#, "", options: .caseInsensitive)
        value = AppleNotes.sub(value, #"<a\b[^>]*\bhref\s*=\s*"(https?://[^"]+)"[^>]*>([\s\S]*?)</a>"#) { g in
            let label = JS.replace(decode(JS.replace(g[2], "<[^>]+>", "")), #"\s+"#, " ").trimmingCharacters(in: .whitespacesAndNewlines)
            let url = decode(g[1])
            return label.isEmpty || label == url ? url : "[\(label)](\(url))"
        }
        value = JS.replace(value, #"<br\s*/?>"#, "\n", options: .caseInsensitive)
        value = JS.replace(value, #"<li\b[^>]*>"#, "\n- ", options: .caseInsensitive)
        value = JS.replace(value, #"</(p|div|tr|li|h[1-6]|table|blockquote|ul|ol)>"#, "\n", options: .caseInsensitive)
        value = JS.replace(value, #"<(p|div|tr|table|blockquote|hr|h[1-6])\b[^>]*>"#, "\n", options: .caseInsensitive)
        value = JS.replace(value, #"</t[dh]>"#, " ", options: .caseInsensitive)
        value = JS.replace(value, "<[^>]+>", "")
        value = JS.replace(decode(value), #"\r\n?"#, "\n")
        let lines = value.components(separatedBy: "\n").map { JS.replace($0, "[ \\t\u{00a0}]+", " ").trimmingCharacters(in: .whitespaces) }
        return JS.replace(lines.joined(separator: "\n"), #"\n{3,}"#, "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Earlier messages quoted in a reply (each is its own message in the thread already), innermost first.
    static func dropQuotes(_ html: String) -> String {
        var value = html
        for _ in 0..<20 {
            let next = JS.replace(value, #"<blockquote\b[^>]*>(?:(?!<blockquote\b)[\s\S])*?</blockquote>"#, "", options: .caseInsensitive)
            if next == value { break }
            value = next
        }
        return value
    }

    static let fileNameRE = #"^[^<>\n/\\]{1,200}\.[A-Za-z0-9]{1,5}$"#

    /// The names of a message's attachments: Gmail's print view lists each in bold beside its size and View / Download links.
    static func attachmentsOf(_ html: String) -> [String] {
        var names: [String] = []
        func add(_ name: String) {
            let value = JS.replace(decode(name), #"\s+"#, " ").trimmingCharacters(in: .whitespacesAndNewlines)
            if JS.test(value, fileNameRE), !JS.test(value, "^https?:", options: .caseInsensitive), !names.contains(value) { names.append(value) }
        }
        for m in JS.matches(html, #"<b>([^<]{1,200})</b>(?:(?!</?b>)[\s\S]){0,400}?(?:attid=|view=att|disp=(?:safe|inline|attd)|\b\d+(?:\.\d+)?\s?[KMG]B?\b)"#, options: .caseInsensitive) { add(m[1] ?? "") }
        for m in JS.matches(html, #"<a\b[^>]*href="[^"]*(?:attid=|view=att)[^"]*"[^>]*>([^<]{1,200})</a>"#, options: .caseInsensitive) { add(m[1] ?? "") }
        return names
    }

    private static let dateFormats = ["EEE, MMM d, yyyy h:mm a", "MMM d, yyyy h:mm a", "EEE, MMM d, yyyy, h:mm a", "MMM d, yyyy, h:mm a",
                                      "EEE, d MMM yyyy HH:mm:ss Z", "d MMM yyyy HH:mm:ss Z", "EEE, d MMM yyyy HH:mm", "d MMM yyyy HH:mm",
                                      "EEE, MMM d, yyyy", "MMM d, yyyy", "yyyy-MM-dd'T'HH:mm:ss.SSSZ", "yyyy-MM-dd'T'HH:mm:ssZ", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"]

    /// `Date.parse` of a Gmail date ("Fri, Oct 10, 2025 at 3:04 PM"): V8 reads these leniently; the formats Gmail's print
    /// view and the readers meet are tried in turn (en_US, this Mac's time zone). nil when none reads it.
    public static func dateOf(_ text: String) -> Double? {
        let cleaned = JS.replace(JS.replace(text, #"\s+at\s+"#, " ", options: .caseInsensitive), #"\s+"#, " ").trimmingCharacters(in: .whitespaces)
        if cleaned.isEmpty { return nil }
        if let d = Time.parse(cleaned) { return Time.ms(d) }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        for format in dateFormats {
            f.dateFormat = format
            if let d = f.date(from: cleaned) { return Time.ms(d) }
        }
        return nil
    }

    public struct Message: Sendable, Equatable { public var sender: String; public var date: String; public var text: String }
    public struct Thread: Sendable, Equatable { public var subject: String; public var messages: [Message]; public var people: [String]; public var attachments: [String] }

    /// A print view read into a thread. A message is a table of class "message" (its first cell the sender, the cell at its
    /// right the date); a page with none of them is kept as one message of its whole text. Messages oldest first; quoted
    /// earlier messages left out of the replies.
    public static func readThread(_ html: String) -> Thread {
        let source = html
        let titled = JS.match(source, #"<title>([\s\S]*?)</title>"#, options: .caseInsensitive)?[1] ?? nil
        let big = JS.match(source, #"<font size=["']?\+1["']?>\s*<b>([\s\S]*?)</b>"#, options: .caseInsensitive)?[1] ?? nil
        let subject = JS.replace(htmlText(big ?? JS.replace(titled ?? "", #"^\s*Gmail\s*-\s*"#, "", options: .caseInsensitive)), #"\s+"#, " ").trimmingCharacters(in: .whitespacesAndNewlines)
        let ns = source as NSString
        let re = try! NSRegularExpression(pattern: #"<table\b[^>]*class=["']?message\b[^>]*>"#, options: .caseInsensitive)
        let starts = re.matches(in: source, range: NSRange(location: 0, length: ns.length)).map { $0.range.location }
        var messages: [Message] = []
        var attachments: [String] = []
        for (i, start) in starts.enumerated() {
            let end = i + 1 < starts.count ? starts[i + 1] : ns.length
            let part = ns.substring(with: NSRange(location: start, length: end - start))
            let pns = part as NSString
            let headEnd = pns.range(of: "</tr>", options: .caseInsensitive).location
            let head = headEnd != NSNotFound && headEnd > 0 ? pns.substring(to: headEnd) : ""
            let cells = JS.matches(head, #"<td\b([^>]*)>([\s\S]*?)</td>"#, options: .caseInsensitive).map { ($0[1] ?? "", $0[2] ?? "") }
            let right: ((String, String)) -> Bool = { JS.test($0.0, #"align=["']?right"#, options: .caseInsensitive) }
            let fromCell = cells.first { !right($0) } ?? cells.first
            let dateCell = cells.first(where: right) ?? (cells.count > 1 ? cells[1] : nil)
            let named = fromCell.flatMap { JS.match($0.1, #"<b>([\s\S]*?)</b>"#, options: .caseInsensitive)?[1] ?? nil } ?? ""
            let address = fromCell.flatMap { JS.match(decode(JS.replace($0.1, "<[^>]+>", " ")), #"<([^<>\s]+@[^<>\s]+)>"#)?[1] ?? nil } ?? ""
            let squash: (String) -> String = { JS.replace($0, #"\s+"#, " ").trimmingCharacters(in: .whitespacesAndNewlines) }
            var sender = squash(htmlText(named))
            if sender.isEmpty { sender = address }
            if sender.isEmpty { sender = squash(htmlText(fromCell?.1 ?? "")) }
            let date = squash(htmlText(dateCell?.1 ?? ""))
            let rest = headEnd != NSNotFound && headEnd > 0 ? pns.substring(from: headEnd) : part
            let files = attachmentsOf(rest)
            for file in files where !attachments.contains(file) { attachments.append(file) }
            var body = JS.replace(dropQuotes(rest), #"<(font|div|span|td)\b[^>]*class=["']?recipient[^>]*>[\s\S]*?</\1>"#, "", options: .caseInsensitive)
            // An attachment's name, size and View / Download links are not the message: its name is listed at the note's end.
            body = JS.replace(body, #"<a\b[^>]*href="[^"]*(?:attid=|view=att)[^"]*"[^>]*>[\s\S]*?</a>"#, "", options: .caseInsensitive)
            for file in files {
                let pieces = body.components(separatedBy: "<b>\(file)</b>")
                body = pieces.enumerated().map { at, piece in at > 0 ? JS.replace(piece, #"^(?:\s|<br\s*/?>)*\d+(?:\.\d+)?\s?[KMG]B?\b"#, "", options: .caseInsensitive) : piece }.joined()
            }
            var text = JS.replace(htmlText(body), #"\n*On [^\n]{5,300} wrote:\s*$"#, "")
            text = JS.replace(text, #"\n{3,}"#, "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
            messages.append(Message(sender: sender, date: date, text: text))
        }
        if messages.isEmpty {
            let body = (JS.match(source, #"<body\b[^>]*>([\s\S]*)</body>"#, options: .caseInsensitive)?[1] ?? nil) ?? source
            attachments.append(contentsOf: attachmentsOf(body))
            messages.append(Message(sender: "", date: "", text: htmlText(dropQuotes(body))))
        }
        let times = messages.map { dateOf($0.date) }
        if times.allSatisfy({ $0 != nil }) {
            messages = zip(messages, times).enumerated().sorted { a, b in a.element.1! != b.element.1! ? a.element.1! < b.element.1! : a.offset < b.offset }.map { $0.element.0 }
        }
        var people: [String] = []
        for m in messages where !m.sender.isEmpty && !people.contains(m.sender) { people.append(m.sender) }
        return Thread(subject: subject, messages: messages, people: people, attachments: attachments)
    }

    /// The day of a thread's last message that has a date, YYYY-MM-DD in this Mac's time zone; nil when none has.
    public static func lastDay(_ thread: Thread) -> String? {
        let times = thread.messages.compactMap { dateOf($0.date) }
        guard let max = times.max() else { return nil }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = .current; f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date(timeIntervalSince1970: max / 1000))
    }

    /// Whether a downloaded print view is Google's sign-in page in its place.
    public static func signedOut(_ html: String) -> Bool {
        let head = String(html.prefix(20000))
        if JS.test(head, #"<table\b[^>]*class=["']?message\b"#, options: .caseInsensitive) { return false }
        return JS.test(head, #"ServiceLogin|accounts\.google\.com/(?:v3/)?signin|identifierId|Sign in - Google Accounts|<title>[^<]*Sign in"#, options: .caseInsensitive)
    }

    /// Whether a downloaded print view is a thread (2026-10-11 review): it came from mail.google.com and holds a message table.
    public static func isThreadPage(finalUrl: String, html: String) -> Bool {
        guard let host = URL(string: finalUrl)?.host else { return false }
        return host == "mail.google.com" && JS.test(html, #"<table\b[^>]*class=["']?message\b"#, options: .caseInsensitive)
    }

    /// A thread as the note that keeps it: a header (Gmail, its dates, its people), then each message, then its attachments' names.
    public static func threadNote(_ thread: Thread) -> String {
        let dates = thread.messages.map(\.date).filter { !$0.isEmpty }
        let span = dates.isEmpty ? "" : (dates[0] == dates[dates.count - 1] ? dates[0] : "\(dates[0])–\(dates[dates.count - 1])")
        let head = ["Gmail", span, thread.people.joined(separator: ", ")].filter { !$0.isEmpty }.joined(separator: " · ")
        var parts = ["*\(head)*"]
        for message in thread.messages {
            let by = [message.sender.isEmpty ? "" : "**\(message.sender)**", message.date].filter { !$0.isEmpty }.joined(separator: ", ")
            parts.append([by, message.text].filter { !$0.isEmpty }.joined(separator: "\n\n"))
        }
        if !thread.attachments.isEmpty { parts.append("Attachments (not brought in): \(thread.attachments.joined(separator: ", "))") }
        return parts.filter { !$0.isEmpty }.joined(separator: "\n\n") + "\n"
    }
}
