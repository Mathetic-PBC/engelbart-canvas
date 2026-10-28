import Foundation
import EngelbartDoc
import EngelbartCore

// cite.cjs — Chat's citations (2026-10-21). Where an answer leans on something in the person's context, Chat cites the
// passage it leans on, inline, as a link with the words it quotes and whose words they are:
//   [You · Oct 12](/abs/path/note.md#find=exact%20words&cite=you)
//   [TutorTrace p. 6](/abs/paper.pdf#find=…&cite=source)
// Nothing a model wrote about a source is trusted: before the answer is written into the document every citation is
// checked against what it cites, and one that cannot be confirmed is taken out, its sentence kept. A citation is kept
// when its address is a library item (by path, or url for a web page), a file inside a library folder, or a workspace
// document of this project, when that source's text can be read, and when the quoted words are in it. Whose words they
// are is checked where the source says: an assistant's turn in an imported chat, or an answer line in a workspace, is
// not the person's, so `you` there becomes `other`. A passage of the conversation being answered is not a source.
// 2026-10-22: a whole source cited (no find) must be among what Chat read; a passage linked without cite= is checked as
// a citation. 2026-10-23: a note on a highlight is citable: theirs, dated by the note, opening the paper there.

public struct CiteKept: Equatable, Sendable {
    public var label, address, source, find: String
    public var note: String?
    public var page: Int?
    public var cite: String
    public var counter: Bool
    public var relabeled: Bool
    public var json: OJ {
        var o: [(String, OJ)] = [("label", .string(label)), ("address", .string(address)), ("source", .string(source)), ("find", .string(find))]
        if let note { o.append(("note", .string(note))) }
        if note != nil { o.append(("page", page.map { .number(Double($0)) } ?? .null)) }
        o += [("cite", .string(cite)), ("counter", .bool(counter)), ("relabeled", .bool(relabeled))]
        return .object(o)
    }
}
public struct CiteDropped: Equatable, Sendable {
    public var label, address, reason: String
    public var json: OJ { ["label": .string(label), "address": .string(address), "reason": .string(reason)] }
}

public enum CiteCheck {
    static let linkRE = JSRegex("\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)", "g")
    static let looseCiteRE = JSRegex("\\[([^\\]\\n]+)\\]\\(((?:(?!\\]\\()[^\\n])*?[#&]cite=[A-Za-z]*(?:&(?:to|counter)=[^&)\\n]*)*)\\)", "g")
    static let nestedLinkRE = JSRegex("\\[([^\\]\\n]+)\\]\\(((?:[^()\\s]|\\([^()\\s]*\\))+)\\)", "g")
    static func isCite(_ href: String) -> Bool { JSRegex("[#&]cite=").test(href) }
    static let fenceRE = JSRegex("^ {0,3}(`{3,}|~{3,})")
    static let maxTextBytes = 8 * 1024 * 1024
    static let speakerRE = JSRegex("^\\*\\*(You|ChatGPT|Codex|Cursor|Claude):\\*\\*\\s")
    static let answerLineRE = JSRegex("^bart[+?]?> ?")

    /// The citations of a line, in order, none overlapping.
    static func citeLinks(_ line: String) -> [JSMatch] {
        var found: [JSMatch] = []
        func overlaps(_ m: JSMatch) -> Bool { found.contains { m.index < $0.index + $0.length && $0.index < m.index + m.length } }
        for re in [looseCiteRE, nestedLinkRE, linkRE] {
            for m in re.matchAll(line) where isCite(m[2] ?? "") && !overlaps(m) { found.append(m) }
        }
        return found.sorted { $0.index < $1.index }
    }

    static func within(_ file: String, _ dir: String) -> Bool {
        let d = dir.hasSuffix("/") ? dir : dir + "/"
        return file.hasPrefix(d) && file.count > d.count
    }

    /// A file Chat must not cite: MEMORY.md, the catalogs and summaries under a `.context` folder. → a reason, or ''.
    public static func notCitable(_ file: String) -> String {
        let base = (file as NSString).lastPathComponent
        if JSRegex("^memory\\.md$", "i").test(base) { return "memory" }
        if file.components(separatedBy: "/").contains(".context") || JSRegex("^catalog\\.json$", "i").test(base) { return "catalog" }
        return ""
    }

    public enum Found {
        case workspace(file: String, workspace: WorkspaceRecord, name: String)
        case row(row: LibraryRow, file: String?, name: String)
        case folderFile(row: LibraryRow, file: String, name: String)
        case reason(String)
        var file: String? { switch self { case .workspace(let f, _, _): return f; case .row(_, let f, _): return f; case .folderFile(_, let f, _): return f; case .reason: return nil } }
        var row: LibraryRow? { switch self { case .row(let r, _, _), .folderFile(let r, _, _): return r; default: return nil } }
        var name: String { switch self { case .workspace(_, _, let n), .row(_, _, let n), .folderFile(_, _, let n): return n; case .reason: return "" } }
        var isWorkspace: Bool { if case .workspace = self { return true }; return false }
        var isRow: Bool { if case .row = self { return true }; return false }
    }

    /// Where a citation's address is.
    public static func resolveSource(_ address: String?, library: [LibraryRow], projectDir: String?, workspaces: [(WorkspaceRecord, String)], dataRoot: String?) -> Found {
        let where_ = (address ?? "").jsTrim
        if where_.isEmpty { return .reason("unresolved") }
        if JSRegex("^https?://", "i").test(where_) {
            let key = AddressKey.addressKey(where_)
            if let row = library.first(where: { !($0.url ?? "").isEmpty && AddressKey.addressKey($0.url) == key }) { return .row(row: row, file: row.path, name: row.name) }
            return .reason("unresolved")
        }
        var file = where_
        if JSRegex("^file://", "i").test(file) {
            guard let u = URL(string: file), let p = decodeURIComponent(u.path) ?? Optional(u.path) else { return .reason("unresolved") }
            file = p
        }
        guard file.hasPrefix("/") else { return .reason("unresolved") }
        file = (file as NSString).standardizingPath
        let banned = notCitable(file)
        if !banned.isEmpty { return .reason(banned) }
        if (file as NSString).lastPathComponent == "workspace.md" {
            let dir = (file as NSString).deletingLastPathComponent
            if let projectDir, within(dir, projectDir) {
                let parts = String(dir.dropFirst(projectDir.count + 1)).components(separatedBy: "/")
                if parts.contains(where: { $0 == ".trash" || $0 == ".archive" }) { return .reason("unresolved") }
                if let (w, _) = workspaces.first(where: { ($0.1 as NSString).standardizingPath == dir }) { return .workspace(file: file, workspace: w, name: w.name) }
                return .reason("unresolved")
            }
            if let dataRoot, within(file, dataRoot) { return .reason("other-project") }
        }
        if let row = library.first(where: { !($0.path ?? "").isEmpty && ($0.path! as NSString).standardizingPath == file && $0.type != "folder" }) { return .row(row: row, file: file, name: row.name) }
        if let folder = library.first(where: { $0.type == "folder" && !($0.path ?? "").isEmpty && within(file, ($0.path! as NSString).standardizingPath) }) {
            return .folderFile(row: folder, file: file, name: (file as NSString).lastPathComponent)
        }
        if let dataRoot, within(file, dataRoot), JSRegex("\\.md$", "i").test(file), !within(file, projectDir ?? "\0") { return .reason("other-project") }
        return .reason("unresolved")
    }

    /// The text of a source file, or nil: a pdf's text layer, a saved page's readable text, any other file as text.
    public static func defaultReadText(_ file: String) -> String? {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file, isDirectory: &isDir), !isDir.boolValue else { return nil }
        if JSRegex("\\.pdf$", "i").test(file) { return try? PdfText.extractText(file) }
        guard let size = (try? FileManager.default.attributesOfItem(atPath: file))?[.size] as? Int, size <= maxTextBytes,
              let data = FileManager.default.contents(atPath: file) else { return nil }
        let raw = String(decoding: data, as: UTF8.self)
        if JSRegex("\\.html?$", "i").test(file) { return HTMLText.text(raw) }
        return raw.contains("\0") ? nil : raw
    }

    static func lineAt(_ text: String, _ at: Int) -> String {
        let ns = text as NSString
        let before = at > 0 ? ns.range(of: "\n", options: .backwards, range: NSRange(location: 0, length: min(at, ns.length))).location : NSNotFound
        let start = before == NSNotFound ? 0 : before + 1
        let after = ns.range(of: "\n", options: [], range: NSRange(location: min(at, ns.length), length: ns.length - min(at, ns.length))).location
        return ns.substring(with: NSRange(location: start, length: (after == NSNotFound ? ns.length : after) - start))
    }

    /// In an imported chat, who said what is at `at`: the speaker of the turn it is in, '' when none.
    public static func speakerAt(_ text: String, _ at: Int) -> String {
        for line in text.jsSlice(0, at).components(separatedBy: "\n").reversed() {
            if let m = speakerRE.match(line) { return m[1] ?? "" }
        }
        return ""
    }
    static func isImportedChat(_ text: String) -> Bool { text.components(separatedBy: "\n").contains { speakerRE.test($0) && !$0.hasPrefix("**You:**") } }

    static let chatDateRE = JSRegex("^\\*[^*\\n]*?·\\s*(\\d{4}-\\d{2}-\\d{2})\\b", "m")

    static func validDate(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        if let d = Time.parse(s) { return d }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return f.date(from: s)
    }

    /// When the cited words were written, as far as their source says.
    static func sourceDate(_ found: Found, _ source: String?) -> Date? {
        if let header = chatDateRE.match((source ?? "").jsSlice(0, 400)) { return validDate("\(header[1]!)T12:00:00") }
        switch found {
        case .workspace(let file, _, _):
            return validDate(OJ.read(URL(fileURLWithPath: ((file as NSString).deletingLastPathComponent as NSString).appendingPathComponent("meta.json")))?["created"]?.string)
        case .row(let row, _, _) where !(row.created ?? "").isEmpty: return validDate(row.created)
        default: break
        }
        guard let f = found.file, let attrs = try? FileManager.default.attributesOfItem(atPath: f) else { return nil }
        if let born = attrs[.creationDate] as? Date, born.timeIntervalSince1970 > 0 { return born }
        return attrs[.modificationDate] as? Date
    }

    static let noteFindWords = 30
    static func firstWords(_ v: String?, _ n: Int) -> String { JSRegex("\\s+").split(v ?? "").filter { !$0.isEmpty }.prefix(n).joined(separator: " ") }
    static func markDate(_ id: String?) -> Date? {
        guard let m = JSRegex("^m(\\d{12,13})").match(id ?? ""), let ms = Double(m[1]!) else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }

    public struct InkNote: Equatable { public var note: String, text: String; public var page: Int?; public var at: Date? }

    /// The notes on a paper's or page's highlights, from its ink.
    public static func inkNotes(_ ink: JSONValue?) -> [InkNote] {
        guard let o = ink?.object else { return [] }
        var out: [InkNote] = []
        func add(_ m: JSONValue, _ page: Int?, _ text: String?) {
            guard let note = m["note"]?.string, !note.jsTrim.isEmpty else { return }
            out.append(InkNote(note: note, text: text ?? "", page: page, at: markDate(m["id"]?.string)))
        }
        // Object.entries order: integer keys ascending, then the rest in insertion order ("web").
        let keys = o.keys.filter { JSRegex("^\\d+$").test($0) }.sorted { (Int($0) ?? 0) < (Int($1) ?? 0) } + o.keys.filter { !JSRegex("^\\d+$").test($0) }.sorted()
        for key in keys {
            guard let list = o[key]?.array else { continue }
            if key == "web" { for m in list { add(m, nil, m["quote"]?.object != nil ? m["quote"]?["exact"]?.string : m["quote"]?.string) } }
            else if JSRegex("^\\d+$").test(key) { for m in list { add(m, Int(key), Highlights.isBox(m) ? "" : m["text"]?.string) } }
        }
        return out
    }

    /// "Oct 12", or "Oct 12, 2025" in another year than `today`'s.
    static func dayLabel(_ date: Date?, today: Date) -> String {
        guard let date else { return "" }
        let cal = Calendar.current
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US")
        f.dateFormat = cal.component(.year, from: date) != cal.component(.year, from: today) ? "MMM d, yyyy" : "MMM d"
        return f.string(from: date)
    }

    /// Who said words cited as someone else's, where the source says.
    static func otherOf(_ source: String, _ at: Int, workspaceDoc: Bool, chat: Bool, label: String) -> String {
        if workspaceDoc && answerLineRE.test(lineAt(source, at)) { return "Chat" }
        let speaker = chat ? speakerAt(source, at) : ""
        if !speaker.isEmpty && speaker != "You" { return speaker }
        let named = label.components(separatedBy: " · ")[0].jsTrim
        return label.contains(" · ") && !named.isEmpty && named.jsLength <= 24 && !JSRegex("^you$", "i").test(named) ? named : "Someone"
    }

    /// The answer's text with a link taken out where it stood, its sentence kept.
    public static func tidyAround(_ line: String, _ start: Int, _ end: Int) -> String {
        var before = JSRegex("[ \\t]+$").replace(line.jsSlice(0, start), with: "")
        var after = JSRegex("^[ \\t]+").replace(line.jsSlice(end), with: "")
        if JSRegex("[(\\[]$").test(before) && JSRegex("^[)\\]]").test(after) {
            before = JSRegex("[ \\t]+$").replace(before.jsSlice(0, -1), with: ""); after = after.jsSlice(1)
        }
        let joined = before.isEmpty || after.isEmpty || JSRegex("^[.,;:!?)\\]]").test(after) ? before + after : "\(before) \(after)"
        var out = JSRegex(" {2,}", "g").replace(joined, with: " ")
        out = JSRegex(" ([.,;:!?])", "g").replace(out) { $0[1] ?? "" }
        let lead = JSRegex("^\\s*").match(line)?.whole ?? ""
        return JSRegex("^\\s+").replace(out) { m in lead.isEmpty ? "" : m.whole }
    }

    public struct Options {
        public var library: [LibraryRow] = []
        public var dataRoot: String?
        public var projectDir: String?
        /// The project's workspaces, each with its folder.
        public var workspaces: [(WorkspaceRecord, String)] = []
        public var workspaceId: String?
        public var currentThread: [(question: String, answer: String)] = []
        public var readText: (String) async -> String? = { defaultReadText($0) }
        public var readRowText: (LibraryRow) async -> String? = { _ in nil }
        public var readInk: (LibraryRow) async -> JSONValue? = { _ in nil }
        public var opened: Set<String>? = nil
        public var today = Date()
        public init() {}
    }

    /// Checks each citation of `body` → (body, kept, dropped): every citation that could not be confirmed taken out and
    /// every `you` that is someone else's made `other`.
    public static func checkCitations(_ body: String?, _ o: Options) async -> (body: String, kept: [CiteKept], dropped: [CiteDropped]) {
        let text = body ?? ""
        var kept: [CiteKept] = [], dropped: [CiteDropped] = []
        if !JSRegex("[#&]cite=|#find=").test(text) { return (text, kept, dropped) }
        let current = o.workspaces.first { $0.0.id == o.workspaceId }
        let threadText = o.currentThread.map { [$0.question, $0.answer].filter { !$0.isEmpty }.joined(separator: "\n") }.joined(separator: "\n")
        let thread = PassageText.fold(threadText, prefixes: true, markdown: true).string
        var reads: [String: String?] = [:]
        func read(_ file: String) async -> String? { if let r = reads[file] { return r }; let r = await o.readText(file); reads[file] = r; return r }
        func rowText(_ row: LibraryRow) async -> String? { let k = "row:\(row.id)"; if let r = reads[k] { return r }; let r = await o.readRowText(row); reads[k] = r; return r }
        var notes: [String: [InkNote]] = [:]
        func notesOf(_ row: LibraryRow) async -> [InkNote] { if let n = notes[row.id] { return n }; let n = inkNotes(await o.readInk(row)); notes[row.id] = n; return n }
        func noteHolding(_ row: LibraryRow, _ words: String?) async -> InkNote? {
            guard let words, !words.isEmpty else { return nil }
            return await notesOf(row).first { !PassageText.matchPassage($0.note, words, markdown: true).isEmpty }
        }
        func isWeb(_ s: String) -> Bool { JSRegex("^https?://", "i").test(s) }

        func check(_ label: String, _ href: String) async -> String? {
            let target = PassageLink.splitTarget(href)
            func cut(_ reason: String) -> String? { dropped.append(CiteDropped(label: label, address: target.address.isEmpty ? href : target.address, reason: reason)); return nil }
            guard let cite = target.cite, !cite.isEmpty else { return cut("malformed") }
            let found = resolveSource(target.address, library: o.library, projectDir: o.projectDir, workspaces: o.workspaces, dataRoot: o.dataRoot)
            if case .reason(let r) = found { return cut(r) }
            if target.find.isEmpty && (target.note ?? "").isEmpty {
                // A whole source: a library item read while answering.
                if found.isWorkspace { return cut("malformed") }
                let keys = [found.file.map { SourceText.openedKey($0) }, (found.row?.url).flatMap { $0.isEmpty ? nil : SourceText.openedKey($0) }].compactMap { $0 }
                guard let opened = o.opened, keys.contains(where: { opened.contains($0) }) else { return cut("not-read") }
                let address = (found.row?.url).flatMap { !$0.isEmpty && isWeb(target.address) ? $0 : nil } ?? found.file ?? target.address
                let source = found.file != nil ? await read(found.file!) : nil
                let by = cite == "you" ? "You" : cite == "other" ? otherOf("", 0, workspaceDoc: false, chat: false, label: label) : ""
                let shown = by.isEmpty ? label : [by, dayLabel(sourceDate(found, source), today: o.today)].filter { !$0.isEmpty }.joined(separator: " · ")
                kept.append(CiteKept(label: shown, address: address, source: found.name.isEmpty ? ((found.file ?? "") as NSString).lastPathComponent : found.name, find: "", note: nil, page: nil, cite: cite, counter: (target.counter ?? false), relabeled: false))
                return "[\(shown)](\(PassageLink.citeHref(address: target.address, find: "", cite: cite, counter: (target.counter ?? false))))"
            }
            let source: String? = found.file != nil ? await read(found.file!) : found.row != nil ? await rowText(found.row!) : nil
            let workspaceDoc = found.isWorkspace
            let markdown = found.file.map { JSRegex("\\.(?:md|markdown|txt|html?)$", "i").test($0) } ?? true
            let hits = source != nil && !target.find.isEmpty && (target.note ?? "").isEmpty ? PassageText.matchPassage(source, target.find, prefixes: workspaceDoc, markdown: markdown) : []
            // The person's note on a highlight of a paper or page (2026-10-23): their words, wherever the model said they were.
            if found.isRow, let row = found.row, !(target.note ?? "").isEmpty || cite == "you" || hits.isEmpty {
                if let n = await noteHolding(row, (target.note ?? "").isEmpty ? target.find : target.note) {
                    let quote = (target.note ?? "").isEmpty ? target.find : target.note!
                    let find = firstWords(n.text, noteFindWords)
                    let shown = ["You", dayLabel(n.at ?? sourceDate(found, nil), today: o.today)].filter { !$0.isEmpty }.joined(separator: " · ")
                    let address = !(row.url ?? "").isEmpty && isWeb(target.address) ? row.url! : found.file ?? target.address
                    kept.append(CiteKept(label: shown, address: address, source: found.name, find: find, note: quote, page: n.page, cite: "you", counter: (target.counter ?? false), relabeled: cite != "you"))
                    return "[\(shown)](\(PassageLink.citeHref(address: target.address, find: find, page: n.page ?? 0, note: quote, cite: "you", counter: (target.counter ?? false))))"
                }
            }
            guard let src = source, !src.jsTrim.isEmpty else { return cut("no-text") }
            if hits.isEmpty { return cut("not-found") }
            if workspaceDoc, let current, case .workspace(_, let w, _) = found, w.id == current.0.id, !thread.isEmpty,
               (thread as NSString).range(of: PassageText.fold(target.find, markdown: true).string, options: .literal).location != NSNotFound { return cut("current-thread") }
            var c = cite, who = ""
            if c == "you" {
                if workspaceDoc && hits.allSatisfy({ answerLineRE.test(lineAt(src, $0.start)) }) { who = "Chat" }
                else if !workspaceDoc && markdown && isImportedChat(src) {
                    let speakers = hits.map { speakerAt(src, $0.start) }
                    if speakers.allSatisfy({ !$0.isEmpty && $0 != "You" }) { who = speakers[0] }
                }
                if !who.isEmpty { c = "other" }
            }
            let address = (found.row?.url).flatMap { !$0.isEmpty && isWeb(target.address) ? $0 : nil } ?? found.file ?? ""
            let by = c == "you" ? "You" : c == "other" ? (who.isEmpty ? otherOf(src, hits[0].start, workspaceDoc: workspaceDoc, chat: !workspaceDoc && markdown && isImportedChat(src), label: label) : who) : ""
            let shown = by.isEmpty ? label : [by, dayLabel(sourceDate(found, src), today: o.today)].filter { !$0.isEmpty }.joined(separator: " · ")
            kept.append(CiteKept(label: shown, address: address, source: found.name.isEmpty ? ((found.file ?? "") as NSString).lastPathComponent : found.name, find: target.find, note: nil, page: nil, cite: c, counter: (target.counter ?? false), relabeled: !who.isEmpty))
            if !who.isEmpty || shown != label || JSRegex("[()\\s]").test(href) {
                return "[\(shown)](\(PassageLink.citeHref(address: target.address, find: target.find, to: target.to, cite: c, counter: (target.counter ?? false))))"
            }
            return "[\(label)](\(href))"
        }

        // A passage of a source in the person's context linked with no `cite=` is a citation that left out whose words they
        // are: given the kind its label or source says, and checked as any other.
        func withKinds(_ line: String) -> String {
            let cites = citeLinks(line)
            return linkRE.replace(line) { m in
                let whole = m.whole, label = m[1] ?? "", href = m[2] ?? "", at = m.index
                if isCite(href) || !JSRegex("#find=").test(href) || label.contains("`") || cites.contains(where: { at < $0.index + $0.length && $0.index < at + whole.jsLength }) { return whole }
                let target = PassageLink.splitTarget(href)
                if target.find.isEmpty { return whole }
                let found = resolveSource(target.address, library: o.library, projectDir: o.projectDir, workspaces: o.workspaces, dataRoot: o.dataRoot)
                if case .reason = found { return whole }
                let who = label.components(separatedBy: " · ")[0].jsTrim
                let kind = JSRegex("^you$", "i").test(who) ? "you" : label.contains(" · ") && who.jsLength <= 24 ? "other"
                    : found.isWorkspace || JSRegex("\\.(?:md|markdown|txt)$", "i").test(found.file ?? "") ? "you" : "source"
                return "[\(label)](\(href)&cite=\(kind))"
            }
        }

        var out: [String] = []
        var fence: String? = nil
        for raw in text.components(separatedBy: "\n") {
            var line = raw
            if let f = fence {
                out.append(line)
                if JSRegex("^ {0,3}\(NSRegularExpression.escapedPattern(for: String(f.first!))){\(f.count),}\\s*$").test(line) { fence = nil }
                continue
            }
            if let open = fenceRE.match(line) { fence = open[1]; out.append(line); continue }
            line = withKinds(line)
            // inline code is no link: its spans are kept out of the search, and put back as they were
            let masked = JSRegex("`[^`\\n]*`", "g").replace(line) { String(repeating: "\0", count: $0.whole.jsLength) }
            let links = citeLinks(masked)
            if links.isEmpty { out.append(line); continue }
            var results: [String?] = []
            for m in links { results.append(await check(m[1] ?? "", m[2] ?? "")) } // in order, so kept and dropped are the answer's
            var now = line
            for i in stride(from: links.count - 1, through: 0, by: -1) {
                let m = links[i]
                if let replaced = results[i] { now = now.jsSlice(0, m.index) + replaced + now.jsSlice(m.index + m.length) }
                else { now = tidyAround(now, m.index, m.index + m.length) }
            }
            out.append(now)
        }
        return (out.joined(separator: "\n"), kept, dropped)
    }
}
