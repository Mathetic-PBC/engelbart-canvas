import Foundation
import EngelbartCore
import EngelbartDoc

// @brainstorm's and @discover's cards in the document (DocEditor cardsOf, pickCard, sendCard, askRepick, repickCard,
// isRecap, endsInRecap, discoverLook, askResult), an @discover guide's papers (model/guide.js guideTitle) and @create's
// words (makingLabel, creatingLine, createDoing, madeNoun, madeToOpen).

public struct CardEntry {
    public var agent: String
    public var card: JSONValue
    public var turn: Turn
    public var thread: DocThread
    /// The card's last line before its foot.
    public var last: Int
    /// The last turn of its thread, unfolded, in an editor that can ask.
    public var live: Bool
    /// What the line under it said, read against it.
    public var answer: CardAnswer?
}

extension EditorCore {
    /// Every card of the document by the line of the question it answers, and every line a card is drawn over.
    public func cardsOf(_ ls: [String]? = nil) -> (byQ: [Int: CardEntry], lines: Set<Int>) {
        let ls = ls ?? lines
        var byQ: [Int: CardEntry] = [:], held = Set<Int>()
        for thread in threads(ls) {
            for (n, turn) in thread.turns.enumerated() {
                let agent = turnAgent(thread, turn)
                guard EditorCore.oneModel(agent), turn.answered, turn.pending == nil, let card = Card.cardOfAnswer(Doc.turnText(ls, turn).answer) else { continue }
                let next = n + 1 < thread.turns.count ? thread.turns[n + 1] : nil
                let said = next.map { Doc.parseLine(ls[$0.q]).text }
                let last = turn.foot >= 0 ? turn.foot - 1 : turn.to
                let answer = said.map { s in Card.readAnswer(models.map { Question.readFlags(s, $0).rest } ?? s, card) }
                byQ[turn.q] = CardEntry(agent: agent, card: card, turn: turn, thread: thread, last: last, live: next == nil && !turn.folded && hooks.ask != nil, answer: answer)
                if turn.from <= last { for i in turn.from...last { held.insert(i) } }
            }
        }
        return (byQ, held)
    }

    /// A card drawn as David's mock (2026-10-14): @discover's or @brainstorm's single choice; any number of rows picked, then Submit.
    public func boxedCard(_ e: CardEntry) -> Bool {
        guard let q = Card.questionOf(e.card) else { return false }
        return (e.agent == "discover" || e.agent == "brainstorm") && q.type != "select_all" && Card.isChoice(q.type)
    }

    /// A row of a live card clicked: a single choice answers with it; a select-all's, or a boxed card's, is ticked.
    public func pickCard(_ q: Int, _ n: Int) {
        guard let e = cardsOf().byQ[q], e.live, let asked = Card.questionOf(e.card), n < asked.labels.count else { return }
        let label = asked.labels[n]
        var held = cardPicks[q] ?? []
        if asked.type != "select_all" && !boxedCard(e) { cardPicks[q] = [label]; sendCard(q); return }
        if held.contains(label) { held.removeAll { $0 == label } } else { held.append(label) }
        cardPicks[q] = asked.labels.filter { held.contains($0) }
    }

    /// An answer to the live card: the reply field's words with the picks (Submit), Skip, or Wrap up (@brainstorm).
    public func sendCard(_ q: Int, how: String = "submit") {
        let ls = lines
        guard let e = cardsOf(ls).byQ[q], e.live, let ask = hooks.ask else { return }
        let skip = how == "skip", wrap = how == "wrap"
        if wrap && e.agent != "brainstorm" { return }
        let typed = followText[e.thread.from] ?? ""
        let asked = Card.questionOf(e.card)
        let given = skip ? Card.skipped : Card.isChoice(asked?.type) ? Card.answerLine(e.card, picks: cardPicks[q] ?? [], note: typed) : Card.answerLine(e.card, text: typed)
        if how == "submit" && given == Card.skipped { return }
        let said = wrap ? Card.withWrap(given) : given
        let flags = followStep(ls, e.thread).flags, text = [flags, said].filter { !$0.isEmpty }.joined(separator: " ")
        let askId = EditorText.newAskId()
        var add = ["@\(Doc.tokenOf(e.agent)) \(text)", "bart~> \(askId)"]; if e.thread.to + 1 >= ls.count { add.append("") }
        let turns = e.thread.turns.filter { $0.answered && $0.pending == nil }.map { t -> AskedTurn in let s = Doc.turnText(ls, t); return AskedTurn(question: s.question, answer: s.answer, agent: t.agent) }
        cardPicks[q] = nil; followText[e.thread.from] = nil; followImages[e.thread.from] = nil
        let discover = e.agent == "discover"
        hooks.asked(askId)
        setLines { x in var out = discover ? x : EditorCore.foldOlder(x, e.thread.turns); out.insert(contentsOf: add, at: e.thread.to + 1); return out }
        activeLine = nil
        ask(AskRequest(askId: askId, text: text, turns: turns, agent: e.agent, placeLine: e.thread.to + 1, placeText: add[0]))
    }

    /// An answered boxed choice may be picked again while nothing in its conversation is at work.
    public func repickable(_ e: CardEntry) -> Bool {
        !e.live && e.answer != nil && !readOnly && hooks.ask != nil && boxedCard(e) && !e.thread.turns.contains { $0.pending != nil }
    }
    /// Another row of an answered choice, confirmed: the line that answered it says the new pick, every turn after it
    /// goes, and it is asked again (one undo brings it all back).
    @discardableResult
    public func repickCard(_ q: Int, _ n: Int) -> String? {
        let ls = lines
        guard let e = cardsOf(ls).byQ[q], repickable(e), let asked = Card.questionOf(e.card), n < asked.labels.count, !(e.answer?.picks.contains(asked.labels[n]) ?? false) else { return nil }
        guard let at = e.thread.turns.firstIndex(of: e.turn), at + 1 < e.thread.turns.count else { return nil }
        let next = e.thread.turns[at + 1]
        let text = Doc.parseLine(ls[next.q]).text
        let flags = models != nil && e.agent == "discover" ? Question.discoverSpans(text, models).map { text.slice($0[0], $0[1]) }.joined(separator: " ") : ""
        let line = "\(EditorCore.leadOf(ls[next.q], e.agent)) \([flags, Card.answerLine(e.card, picks: [asked.labels[n]], note: "")].filter { !$0.isEmpty }.joined(separator: " "))"
        let later = e.thread.turns.filter { $0.q > next.q }
        var kept = later.isEmpty ? ls : Array(ls[..<later[0].q]) + Array(ls[(e.thread.to + 1)...])
        kept[next.q] = line
        return regenerate(next.q, edited: (kept, (ls.joined(separator: "\n"), history.count)))
    }

    /// What a question line answering a card says when drawn: the picks, a note, the words, Skipped or Wrapped up.
    public func answerShown(_ a: CardAnswer) -> (text: String, grey: String?) {
        let given = !a.picks.isEmpty ? a.picks.joined(separator: ", ") + (a.note.isEmpty ? "" : " · \(a.note)") : a.text
        if a.wrap { return given.isEmpty ? ("", "Wrapped up") : (given, " · Wrapped up") }
        return a.skipped ? ("", "Skipped") : (given, nil)
    }

    /// Whether an @brainstorm answer is an older recap: no card, and two labelled sections or nothing but sections.
    public func isRecap(_ ls: [String], _ turn: Turn) -> Bool {
        let answer = Doc.turnText(ls, turn).answer
        let said = answer.components(separatedBy: "\n").filter { !$0.trimmed.isEmpty }
        let sections = said.filter { Card.recapLine($0) != nil }.count
        return Card.cardOfAnswer(answer) == nil && (sections >= 2 || (sections > 0 && sections == said.count))
    }
    /// A thread of @brainstorm's that ends in a recap, its last turn at rest: Send to Discover stands under it.
    public func endsInRecap(_ ls: [String], _ thread: DocThread) -> Bool {
        guard let end = thread.turns.last, hooks.ask != nil, Doc.answeredBy(thread) == "brainstorm", end.answered, end.pending == nil, !end.folded else { return false }
        return isRecap(ls, end)
    }

    /// After the thread line `i` is in: a blank line and `@discover <query>` (or `@chat`) with its pending line, asked.
    public func discoverLook(_ i: Int, query: String = "", agent: String = "discover") {
        let ls = lines
        guard let thread = threads(ls).first(where: { $0.from <= i && i <= $0.to }), let ask = hooks.ask, !(agent == "bart" && query.isEmpty) else { return }
        let askId = EditorText.newAskId(), token = "@\(Doc.tokenOf(agent))"
        var add = ["", query.isEmpty ? token : "\(token) \(query)", "bart~> \(askId)"]; if thread.to + 1 >= ls.count { add.append("") }
        setLines { x in var out = x; out.insert(contentsOf: add, at: thread.to + 1); return out }
        activeLine = nil
        ask(AskRequest(askId: askId, text: query, turns: [], agent: agent, placeLine: thread.to + 2, placeText: add[1]))
    }
    /// @discover or @chat on a result's offer line (MATH-40): asked on the sentence above it.
    public func askResult(_ i: Int, agent: String) {
        let ls = lines
        guard agent == "discover" || agent == "bart", let t = threads(ls).first(where: { $0.from <= i && i <= $0.to }),
              let turn = t.turns.first(where: { $0.from <= i && i <= $0.to }), let sentence = Card.resultParts(Doc.turnText(ls, turn).answer) else { return }
        discoverLook(i, query: sentence, agent: agent)
    }
    /// The walkthrough's handoff: @discover on the last @brainstorm result's sentence, unless one was asked after it.
    @discardableResult
    public func discoverLastResult(_ askId: String? = nil) -> Bool {
        let ls = lines
        if let id = askId, ls.contains("bart~> \(id)") { return false }
        for t in threads(ls).reversed() {
            if Doc.answeredBy(t) == "discover" { return false }
            guard let turn = t.turns.last, turn.answered, turn.pending == nil, let sentence = Card.resultParts(Doc.turnText(ls, turn).answer) else { continue }
            discoverLook(turn.q, query: sentence); return true
        }
        return false
    }

    // MARK: an @discover guide's papers

    static let GUIDE_TITLE = Rx(#"^\*\*\[([^\]\n]+)\]\(([^)\s]+)\)"#)
    static let ABSTRACT_ONLY = Rx(#"^\*\*Read:\*\*\s*["“]?abstract only\b"#, "i")
    /// A guide's title line → its paper (title, address), or nil (model/guide.js guideTitle).
    public static func guideTitle(_ text: String?, next: String? = nil) -> (title: String, address: String)? {
        guard let m = GUIDE_TITLE.match(text ?? "") else { return nil }
        if let next, ABSTRACT_ONLY.test(next.trimmed) { return nil }
        var address = Rx(#"#.*$"#).replace(m[2]!, with: "")
        if address.hasPrefix("/"), Rx(#"%[0-9a-f]{2}"#, "i").test(address) { address = address.decodeURIComponent ?? address }
        guard Rx(#"^(?:https?:\/\/\S|\/|file:\/\/)"#, "i").test(address) else { return nil }
        let title = Rx(#"\s+"#).replace(m[1]!, with: " ").trimmed.slice(0, 200).trimmed
        return title.isEmpty ? nil : (title, address)
    }
    /// The papers of turn `q`'s guide not in this project yet ('none' or 'lib'), once each, in order.
    public func unsavedPapers(_ q: Int, state: (String) -> String?) -> [(line: Int, title: String, address: String)] {
        let ls = lines, ps = parsed(ls)
        guard let found = findTurn(ls, q) else { return [] }
        var out: [(Int, String, String)] = []
        if found.turn.from <= found.turn.to {
            for i in found.turn.from...found.turn.to where ps[i].type == .reply && !ps[i].folded {
                let next = i + 1 <= found.turn.to ? Doc.parseLine(ls[i + 1]) : nil
                guard let paper = EditorCore.guideTitle(ps[i].text, next: next?.type == .reply ? next?.text : nil) else { continue }
                let st = state(paper.address)
                if (st == "none" || st == "lib") && !out.contains(where: { $0.2 == paper.address }) { out.append((i, paper.title, paper.address)) }
            }
        }
        return out.map { (line: $0.0, title: $0.1, address: $0.2) }
    }
}

// MARK: @create's words

public enum CreateWords {
    static let MADE_NOUN = ["svg": "Diagram", "html": "Page", "htm": "Page", "md": "Document", "markdown": "Document", "csv": "Dataset", "tsv": "Dataset", "json": "Data", "jsonl": "Data", "ndjson": "Data", "png": "Image", "jpg": "Image", "jpeg": "Image", "gif": "Image", "webp": "Image", "pdf": "PDF", "parquet": "Data", "xlsx": "Spreadsheet", "docx": "Document"]
    static func ext(_ name: String) -> String { Rx(#"\.([^./]+)$"#).match(name)?[1]?.lowercased() ?? "" }
    static func isScript(_ text: String?) -> Bool {
        let ls = (text ?? "").components(separatedBy: "\n")
        let fences = ls.filter { Rx(#"^\s*```"#).test($0) }.count
        guard fences == 2, let first = ls.firstIndex(where: { Rx(#"^\s*```"#).test($0) }) else { return false }
        return ls.contains { !$0.trimmed.isEmpty && !Rx(#"^\s*```"#).test($0) } && ls[..<first].filter { !$0.trimmed.isEmpty }.count <= 3
    }
    /// What a made file is called by its kind ("Diagram", "Script", …).
    public static func madeNoun(_ name: String, text: String? = nil) -> String {
        Rx(#"^(md|markdown)$"#).test(ext(name)) && isScript(text) ? "Script" : MADE_NOUN[ext(name)] ?? "File"
    }
    static let MAKING = ["slide deck", "slides", "presentation", "diagram", "flowchart", "chart", "graph", "plot", "map", "timeline", "page", "website", "site", "dashboard", "document", "report", "essay", "summary", "outline", "plan", "list", "table", "dataset", "spreadsheet", "script", "image", "picture", "poster", "svg", "csv", "html"]
    static let FORMATS = ["html": "HTML", "markdown": "Markdown", "md": "Markdown", "json": "JSON", "pdf": "PDF"]
    /// "Creating a diagram", from what it said it makes, else the request, else the file it writes; else "Create".
    public static func makingLabel(_ said: String?, _ request: String?, _ writing: String?) -> String {
        for text in [said, request] {
            let t = (text ?? "").lowercased()
            var best: (at: Int, word: String)? = nil
            for w in MAKING { if let m = Rx("\\b\(w)\\b").match(t), best == nil || m.index < best!.at { best = (m.index, w) } }
            if let best {
                let format = Rx(#"\b(html|markdown|md|json|pdf)\s+$"#).match(t.slice(0, best.at))?[1]
                let word = best.word == "svg" ? "diagram" : best.word == "csv" ? "dataset" : best.word == "html" ? "HTML page" : format != nil ? "\(FORMATS[format!]!) \(best.word)" : best.word
                return word.hasSuffix("s") && word != "analysis" ? "Creating \(word)" : "Creating \(Rx(#"^(?:[aeiou]|HTML)"#).test(word) ? "an" : "a") \(word)"
            }
        }
        if let w = writing, let noun = MADE_NOUN[ext(w)] { return "Creating \(Rx("^[AEIOU]").test(noun) ? "an" : "a") \(noun.lowercased())" }
        return "Create"
    }
    /// "A diagram of …." → "Creating a diagram of …"; an acronym's capital stays.
    public static func creatingLine(_ said: String?) -> String {
        let text = Rx(#"[.…]+$"#).replace((said ?? "").trimmed, with: "")
        if text.isEmpty { return "" }
        if Rx(#"^creating\b"#, "i").test(text) { return "\(text)…" }
        let first = Rx(#"^[A-Z](?:[a-z]|\s)"#).test(text) ? text.slice(0, 1).lowercased() + text.slice(1) : text
        return "Creating \(first)…"
    }
    static let CODE_EXT = Rx(#"^(?:c?js|mjs|jsx|tsx?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|cs|php|sh|css|scss|vue|svelte|sql|toml|ya?ml|json|jsonl)$"#)
    static let MAKE_VERB = ["Diagram": "Drawing the diagram", "Page": "Building the page", "Document": "Writing the document", "Dataset": "Filling in the dataset", "Data": "Writing the data", "Image": "Drawing the image"]
    /// What a Create run is doing, in words anyone reads: never a file's name or path.
    public static func createDoing(_ activity: String?, kind: String?, wrote: Bool) -> String {
        let a = activity ?? ""
        if let m = Rx(#"^(Writing|Editing) (.+?)(?: · (\d+) KB)?$"#).match(a) {
            let noun = MADE_NOUN[ext(m[2]!)]
            return m[1] == "Editing" ? "Revising the \((noun ?? "file").lowercased())" : MAKE_VERB[noun ?? ""] ?? "Writing the file"
        }
        if let m = Rx(#"^Reading (.+)$"#).match(a) {
            let what = m[1]!, e = ext(what)
            if Rx(#"^(?:md|markdown|txt)$"#).test(e) { return "Reading your notes" }
            if e == "pdf" { return "Reading a paper" }
            if Rx(#"^(?:png|jpe?g|gif|webp|svg)$"#).test(e) { return "Looking at an image" }
            if CODE_EXT.test(e) || e == "html" { return "Reading the code" }
            if !what.contains("/"), Rx(#"^[a-z0-9-]+(?:\.[a-z0-9-]+)+$"#, "i").test(what) { return "Reading a page on \(what)" }
            return "Reading a file"
        }
        if Rx(#"^Searching code\b"#).test(a) { return "Searching the code" }
        if Rx(#"^Listing\b"#).test(a) { return "Looking through your files" }
        if Rx(#"^Using\b|^Running\b"#).test(a) { return "Working" }
        if a.isEmpty || Rx(#"^(?:Thinking|Thinking harder|Writing)$"#).test(a) { return wrote ? "Finishing up" : kind.map { "Planning the \($0)" } ?? "Thinking it through" }
        return a
    }
    /// The file a finished Create run opens in the Stage: the first made row of its answer, once per run, while the person is still where it was asked.
    public static func madeToOpen(lines: [String], stopped: Bool, failed: Bool, askId: String, askedIn: String?, here: String?, active: Bool = true, opened: inout Set<String>) -> Inline.MadeMention? {
        if stopped || failed || askId.isEmpty || opened.contains(askId) || !active || askedIn == nil || askedIn != here { return nil }
        for line in lines { if let made = Inline.madeMentionOf(Rx(#"^bart>\s?"#).replace(line, with: "")) { opened.insert(askId); return made } }
        return nil
    }
}
