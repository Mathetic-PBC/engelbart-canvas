import Foundation
import CryptoKit
import EngelbartCore

// ask.cjs, the parts that decide before and after a run (pure, or nearly): one @bart question, from the line in the
// document to the answer under it (2026-09-19). No router in front: the question starts on the first step of the ladder
// and the agent itself may ask for the next step by replying "ESCALATE: <why>". Moving up resumes the same CLI session at
// a higher model and effort, so everything it has read stays in context. Flags on the line pick one step by hand and turn
// that off. Follow-ups (2026-09-21): a question asked right under an answer continues that exchange; what is kept is the
// session id, for 30 idle minutes (two hours for @brainstorm and @discover), found by what the document says was said
// (threadKey). @brainstorm (2026-10-14) is a conversation in prose, its opening a card (2026-10-16); the Welcome
// walkthrough's exchange is three cards. @discover settles the direction in conversation, then a research box searches
// (<research>, <search>, <mode>, <refine>, steers). @create makes files in a draft folder (Create).

public struct Turn: Equatable, Sendable {
    public var question: String
    public var answer: String
    /// The agent that answered it, when the document says ('bart', 'brainstorm', 'discover', 'create').
    public var agent: String?
    public init(question: String, answer: String, agent: String? = nil) { self.question = question; self.answer = answer; self.agent = agent }
}

public struct BartError: Error, LocalizedError, Equatable {
    /// 'unavailable' | 'failed' | 'stopped'
    public let kind: String
    public let message: String
    public init(_ kind: String, _ message: String) { self.kind = kind; self.message = message }
    public var errorDescription: String? { message }
    public static let stopped = BartError("stopped", "Stopped.")
}

/// A reply sent under a running search, or its level picked while it ran (ask.cjs pausedFor, 2026-10-16).
public struct Steer: Equatable, Sendable {
    public var after: String, words: String, level: Bool
    public init(after: String, words: String, level: Bool = false) { self.after = after; self.words = words; self.level = level }
}

/// turnPlan's result.
public struct TurnPlan: Sendable {
    public var agent: String
    public var brainstorm: Bool
    public var question: String
    public var provider: String
    public var steps: [Step]
    public var pinned: Bool
    public var mode: String?
    public var prior: [Turn]
    public var asked: String
    public var shown: [Turn]
    public var extra: String
    // @discover
    public var search = false, refine = false, refining = false
    // the Welcome walkthrough
    public var welcome = false
    public var path: String?
    public var stage: String?
    public var result: String?
    public var written: String?
}

public enum AskPlan {
    public static let stepTimeout: TimeInterval = 15 * 60
    public static let discoverTimeout: TimeInterval = 30 * 60
    /// Opus max or Astra ultra, two hops from up to five starting points, may need longer (2026-10-02).
    public static let deepDiscoverTimeout: TimeInterval = 45 * 60
    public static let threadIdle: TimeInterval = 30 * 60
    public static let brainstormIdle: TimeInterval = 2 * 60 * 60
    public static let discoverIdle: TimeInterval = 2 * 60 * 60
    public static let maxTurns = 40
    public static let escalateRE = JSRegex("^ESCALATE:\\s*(.{0,400})$", "s")
    /// How long a search stopped by a reply keeps its session for the run that goes on.
    public static let steerKeep: TimeInterval = 10 * 60
    static let uuidRE = JSRegex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i")
    public static let claudeTools = "Read,Grep,Glob,WebSearch,WebFetch"
    public static let brainstormTools = "Read,Grep,Glob"
    /// @create's: @bart's, and Write and Edit, which its permission rules allow in its draft folder alone (createRules).
    public static let createTools = "\(claudeTools),Write,Edit"
    /// @discover's paper tools, as Claude Code names an MCP server's tools.
    public static let paperTools = "mcp__papers__*"
    public static let agents = ["bart", "brainstorm", "discover", "create"]
    /// Each agent's prompt file under <dataRoot>/.context/, and its built-in text. `welcome` is the Welcome walkthrough's.
    public static let prompts: [String: (file: String, text: String)] = [
        "bart": ("bart-system-prompt.md", Prompts.bart), "brainstorm": ("brainstorm-system-prompt.md", Prompts.brainstorm),
        "discover": ("discover-system-prompt.md", Prompts.discover), "create": ("create-system-prompt.md", Prompts.create),
        "welcome": ("brainstorm-welcome-system-prompt.md", Prompts.welcome),
    ]
    /// The agents on one fixed step whose model is never named, while they run or in their foot (2026-10-02, B-05).
    public static let quiet: Set<String> = ["brainstorm"]
    public static let welcomeCards = 3
    static let workingID = "working", workingTitle = "What are you working on?"
    static let stageID = "stage", stageTitle = "Where are you in the process?"
    static let stages = ["Just exploring", "Reading what’s out there", "I have a question I want to answer", "Building or running something", "Writing it up"]
    static let welcomeNextTitle = "What are your next steps?"
    /// What an @discover line with nothing after it asks (2026-10-14).
    public static let discoverOpening = "Start from this workspace."
    static let searchBlock = "<search>The direction is settled: search on the one in <question> now, and reply with the reading guide.</search>"
    static func refineBlock(_ current: String) -> String {
        "<refine>The person is refining the research direction\(current.isEmpty ? "" : ". The direction last searched: \(current)"). Their latest words take precedence over anything said before.</refine>"
    }
    /// How far each mode traces (the prompt's <mode>), and how many of its sources are essays when essays apply.
    public static let modeLimits = [
        "quick": "quick. Up to two starting points; one hop backward and one forward from each; at most five sources in the guide, of which up to two are essays when essays apply.",
        "standard": "standard. Up to three starting points; one hop backward and one forward from each; at most eight sources in the guide, of which two to three are essays when essays apply.",
        "deep": "deep. Up to five starting points; one hop backward and one forward from each, then one more of each from the best of what you found; at most fifteen sources in the guide, of which three to five are essays when essays apply.",
    ]

    /// The agent's instructions: <dataRoot>/.context/<agent>-system-prompt.md when it holds any, else the built-in ones.
    public static func loadSystemPrompt(_ dataRoot: String, agent: String = "bart") -> String {
        let (file, builtIn) = prompts[agent] ?? prompts["bart"]!
        if let custom = try? String(contentsOfFile: ((dataRoot as NSString).appendingPathComponent(".context") as NSString).appendingPathComponent(file), encoding: .utf8) {
            let t = custom.jsTrim
            if !t.isEmpty { return t }
        }
        return builtIn
    }

    public static func levelBlock(_ steps: [Step], _ at: Int, pinned: Bool) -> String {
        let level = steps[at]
        let now = "You are running as \(level.name) at \(level.effort) effort"
        if pinned { return "<level>\(now). The person chose this model and effort by hand: no higher step exists.</level>" }
        let next = at + 1 < steps.count ? steps[at + 1] : nil
        return "<level>\(now), step \(at + 1) of \(steps.count). \(next.map { "A higher step exists: \($0.name) at \($0.effort) effort." } ?? "No higher step exists.")</level>"
    }

    // An @discover research box's line is `@discover --research <problem>`: the flag says where the editor draws it.
    static let researchRE = JSRegex("(^|\\s)--research(?=\\s|$)", "gi")
    public static func withoutResearch(_ text: String?) -> String { researchRE.replace(text ?? "") { $0[1] ?? "" }.squashedSpaces }
    /// A research box's line with what the person said while it searched (`--steer <words>`, once a reply).
    public static func steersShown(_ text: String?) -> String {
        let parts = JSRegex("\\s+--steer\\s+", "i").split(text ?? "")
        guard parts.count > 1 else { return parts[0] }
        return "\(parts[0].jsTrim) (also: \(parts.dropFirst().map { $0.jsTrim }.filter { !$0.isEmpty }.joined(separator: "; ")))"
    }
    /// What a search is told when it goes on, in its own session, with a reply sent while it ran, or a level picked.
    public static func steerMessage(_ words: String, mode: String? = nil) -> String {
        [mode.flatMap { modeLimits[$0] }.map { "While you were searching, the person changed how far to search:\n\n<mode>\($0)</mode>" } ?? "",
         words.isEmpty ? "" : "While you were searching, the person added this:\n\n\(words)",
         "Take it into account and carry on from where you are. Keep what you found that still fits, \(words.isEmpty ? "search as far as the new level goes" : "look further where it points"), and do not start the search over. Then write the guide as before.",
        ].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
    /// Whether an @discover line is a research box's, the search (2026-10-14).
    public static func isSearch(_ text: String?) -> Bool { JSRegex("(^|\\s)--research(?=\\s|$)", "i").test(text ?? "") }
    static func refineShown(_ text: String?) -> String { let r = Question.readRefine(text); return r.refine ? "Refine the research direction: \(r.rest)" : (text ?? "") }

    /// A turn as it is told and as its session is kept by: trimmed, a question past 8,000 characters or an answer past
    /// 20,000 cut in the middle.
    public static func cleanTurn(_ t: Turn) -> Turn {
        Turn(question: Clip.clipMiddle(refineShown(withoutResearch(steersShown(t.question))), 8000),
             answer: Clip.clipMiddle(t.answer.jsTrim, 20000), agent: t.agent.flatMap { agents.contains($0) ? $0 : nil })
    }

    /// The earlier turns as the renderer read them, made safe: bounded, no empty questions (`keepEmpty`: @brainstorm's
    /// and @discover's, whose first line may say nothing and still be a turn).
    public static func cleanTurns(_ turns: [Turn], keepEmpty: Bool = false) -> [Turn] {
        Array(turns.filter { keepEmpty || !$0.question.jsTrim.isEmpty }.suffix(maxTurns)).map(cleanTurn)
    }

    /// Whether a follow-up is asked of another agent than the one that answered the turn before it.
    public static func switched(_ prior: [Turn], _ agent: String) -> Bool {
        guard let last = prior.last, let a = last.agent else { return false }
        return a != agent
    }

    /// Where an exchange stands: the document it is in and everything said in it so far. Two exchanges that read the same
    /// are the same. (`JSON.stringify([projectId, ref.kind, ref.id || ref.workspaceId, turns.map(q, a)])`, sha256 hex.)
    public static func threadKey(_ projectId: String, _ ref: DocRef, _ turns: [Turn]) -> String {
        let id: OJ = ref.keyId.map { .string($0) } ?? .null
        let json: OJ = [.string(projectId), .string(ref.kind), id, .array(turns.map { [.string($0.question), .string($0.answer)] })]
        return SHA256.hash(data: Data(json.stringify().utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static let routedBuild = "<routed>The person wants this built. Write the Build prompt as one fenced code block, after at most two sentences. End with one short line asking whether they want you to build it, such as `Want me to build it?` Do not write [[build]] or tell them to press anything.</routed>"
    static func routedBlock(_ routed: Routed?) -> String { routed?.build == true ? routedBuild : "" }
    static func topicBlock(_ topic: String?) -> String { topic.flatMap { $0.isEmpty ? nil : "<topic>\(JSRegex("[<>]", "g").replace($0, with: ""))</topic>" } ?? "" }

    /// What a question is given: everything, for a new session; the question alone, for a session that already holds the
    /// rest (a resumed @bart turn also the Stage and highlights as they are now). `extra` goes in front of the level.
    public static func firstMessage(context: BartContext, prior: [Turn], question: String, resumed: Bool, extra: String = "", routed: Routed? = nil, agent: String? = nil, topic: String? = nil) -> (String) -> String {
        let asked = [routedBlock(routed), topicBlock(topic), "<question>\n\(question)\n</question>"].filter { !$0.isEmpty }.joined(separator: "\n\n")
        if resumed { return { level in [extra, context.now, level, asked].filter { !$0.isEmpty }.joined(separator: "\n\n") } }
        return { level in
            [context.head, context.contextJson, context.mentionedFiles, context.documents, Context.conversationBlock(prior, agent: agent), extra, level, asked]
                .filter { !$0.isEmpty }.joined(separator: "\n\n")
        }
    }

    /// Where the cards at the end of `turns` begin: after the last recap, or the last reply that was not a card.
    static func cardsFrom(_ turns: [Turn]) -> Int {
        var from = turns.count
        while from > 0 && Card.cardOfAnswer(turns[from - 1].answer) != nil { from -= 1 }
        return from
    }

    /// A card's id (a focus card is the first card's, "mind").
    static func idOf(_ card: OJ) -> String { card["card"]?.string == "focus" ? "mind" : (Card.questionOf(card)?.id ?? "") }

    /// One turn of any agent, read from the line before anything runs.
    public static func turnPlan(agent: String, text: String, turns: [Turn], choice: (model: String, effort: String)?, welcome: Bool, models: ModelsList) -> TurnPlan {
        let brainstorm = agent == "brainstorm", discover = agent == "discover"
        let prior = cleanTurns(turns, keepEmpty: brainstorm || discover)
        let named: QuestionRead
        if brainstorm { named = Models.readBrainstorm(text, models) }
        else if discover { named = Question.readDiscover(withoutResearch(steersShown(text)), models, prior.map { $0.question }) }
        else { named = Question.readQuestion(choice.map { Question.withChoice(text, models, model: $0.model, effort: $0.effort) } ?? text, models) }
        // Regenerate's selector (2026-10-16, David) asks @brainstorm and @discover again on the model and effort picked there.
        var read = named
        if (brainstorm || discover), let choice, let picked = Question.modelOf(choice.model, models), let effort = Question.effortOf(choice.effort),
           let entry = models.providers[picked.provider], entry.efforts.contains(effort), let info = entry.models[picked.model] {
            read = QuestionRead(question: named.question, provider: picked.provider, steps: [Step(provider: picked.provider, key: picked.model, model: info.id, name: info.name, effort: effort)], pinned: false, mode: named.mode)
        }
        func plan(_ agentName: String) -> TurnPlan {
            TurnPlan(agent: agentName, brainstorm: brainstorm, question: read.question, provider: read.provider, steps: read.steps, pinned: read.pinned, mode: read.mode,
                     prior: prior, asked: read.question, shown: prior, extra: "")
        }
        if discover {
            let search = isSearch(text)
            let raw = turns.map { $0.question }
            let last = raw.lastIndex(where: isSearch) ?? -1
            let refine = Question.readRefine(text).refine
            let refining = !search && (refine || raw.dropFirst(last + 1).contains { Question.readRefine($0).refine })
            let current = last >= 0 ? withoutResearch(Question.readProvider(Question.readMode(raw[last]).rest).rest) : ""
            var p = plan(agent)
            p.search = search; p.refine = refine; p.refining = refining
            p.asked = read.question.isEmpty ? discoverOpening : read.question
            p.shown = prior.map { t in
                var s = t; if s.question.isEmpty { s.question = discoverOpening }
                if let card = Card.cardOfAnswer(t.answer) { s.answer = Card.cardAsText(card) }
                return s
            }
            p.extra = search ? "<mode>\(modeLimits[read.mode ?? "standard"]!)</mode>\n\n\(searchBlock)" : refining ? refineBlock(current) : ""
            return p
        }
        // @create asks as @bart does, on @bart's models (2026-10-13).
        if !brainstorm { return plan(agent == "create" ? "create" : "bart") }
        // An ordinary @brainstorm (2026-10-14): the question and the conversation so far, nothing else.
        let from = cardsFrom(prior)
        let opening = from < prior.count ? Models.readBrainstorm(prior[from].question, models).question : read.question
        if !(welcome && opening.jsTrim.isEmpty) {
            var p = plan(agent)
            p.asked = read.question.isEmpty ? Card.opening : read.question
            p.shown = prior.map { t in
                var s = t; if s.question.isEmpty { s.question = Card.opening }
                if let card = Card.cardOfAnswer(t.answer) { s.answer = Card.cardAsText(card) }
                return s
            }
            return p
        }
        // The Welcome walkthrough's exchange: three cards; the first and the next are the agent's, the stage card code's.
        let cards = Array(prior[from...])
        let last = cards.last.flatMap { Card.cardOfAnswer($0.answer) }
        let answer = last.map { Card.readAnswer(read.question, $0) }
        let lastId = last.map(idOf)
        let stage = last == nil ? "first" : lastId == Card.nextID ? "result" : (answer!.wrap || cards.count >= welcomeCards - 1) ? "next" : stageID
        let result = stage == "result" ? Card.resultText(answer!.skipped ? "" : [answer!.picks.joined(separator: ", "), answer!.text, answer!.note].filter { !$0.isEmpty }.joined(separator: "; ")) : nil
        var p = plan(agent)
        p.path = "welcome"; p.stage = stage; p.result = result; p.welcome = true
        p.written = stage == stageID ? Card.cardBody(stageCard()).body : result
        p.asked = read.question.isEmpty ? Card.opening : read.question
        p.shown = prior.map { t in var s = t; if s.question.isEmpty { s.question = Card.opening }; return s }
        p.extra = "<path>welcome</path>\n<stage>\(stage)</stage>\n<card>\(cards.count + 1) of \(welcomeCards)</card>"
        return p
    }

    /// The Welcome walkthrough's last card: the agent's lead-in said above its title, which code fixes.
    static func nextCard(_ lead: String = "", _ title: String = welcomeNextTitle) -> String {
        (["say": .string(lead), "card": "questions", "questions": ["eyebrow": "what next", "items": [["id": .string(Card.nextID), "type": "open", "title": .string(title), "placeholder": .string(Card.nextPlaceholder)]]], "ready": false] as OJ).stringify()
    }
    /// The welcome path's second card, written by code: where they are in the process, one pick or their own words.
    static func stageCard() -> String {
        (["say": "", "card": "questions", "questions": ["eyebrow": "where you are", "items": [["id": .string(stageID), "type": "mcq", "title": .string(stageTitle), "options": .array(stages.map { ["label": .string($0)] })]]], "ready": false] as OJ).stringify()
    }

    /// What the Welcome walkthrough's @brainstorm replied, as the document keeps it.
    public static func welcomeReply(_ text: String, stage: String?) -> String {
        let card = Card.readCard(text)
        let asked = card.flatMap { $0["card"]?.string != "none" ? $0 : nil }
        let say = asked?["say"]?.string ?? ""
        if stage == "first" {
            return (["say": .string(say), "card": "questions", "questions": ["eyebrow": "to start", "items": [["id": .string(workingID), "type": "open", "title": .string(workingTitle), "placeholder": "In your own words…"]]], "ready": false] as OJ).stringify()
        }
        if stage == "next" { return nextCard(say) }
        return asked?.stringify() ?? text
    }

    /// The escalation loop, apart from any CLI. `turn(level, message, session)` sends one message → (text, session).
    public static func climb(steps: [Step], pinned: Bool, first: (String) -> String, session resumed: String? = nil,
                             onProgress: ((BartProgress) -> Void)? = nil, quiet: Bool = false, now: () -> Double = { Time.ms() },
                             turn: (Step, String, String?) async throws -> (text: String, session: String?)) async throws -> (text: String, level: Step, trail: [ReplyMeta.Moved], session: String?, ms: Double) {
        let started = now()
        var trail: [ReplyMeta.Moved] = []
        var session = resumed
        var at = 0
        var message = first(levelBlock(steps, 0, pinned: pinned))
        var insisted = false
        while true {
            let level = steps[at]
            onProgress?(.step(step: at + 1, of: steps.count, name: quiet ? nil : level.name, effort: quiet ? nil : level.effort, movedUp: trail.count))
            let out = try await turn(level, message, session)
            session = out.session
            let text = out.text.jsTrim
            let wants = text.jsLength < 500 ? escalateRE.match(text) : nil
            guard let wants else { return (text, level, trail, session, now() - started) }
            let why = (wants[1] ?? "").jsTrim
            if at < steps.count - 1 {
                trail.append(ReplyMeta.Moved(name: level.name, effort: level.effort, why: why))
                at += 1
                message = "\(levelBlock(steps, at, pinned: pinned))\n\nYou asked to move up, and you have. Everything you read is still in this conversation. Answer the question now."
            } else if !insisted {
                insisted = true
                message = "\(levelBlock(steps, at, pinned: pinned))\n\nNo higher step exists. Answer the question now, as well as you can, and say what you are unsure of."
            } else {
                return ("I could not answer this at the highest step available. \(why)", level, trail, session, now() - started)
            }
        }
    }

    /// The config.toml of a private Codex home: the MCP servers it starts and nothing else; written only when it changes.
    public static func writeCodexConfig(_ home: String, servers: [(name: String, command: String, args: [String], env: [(String, String)])]) {
        func toml(_ v: String) -> String { jsonQuote(v) }
        var lines = ["# Written by Engelbart (src/main/bart/ask.cjs). Replaced on every run.", "cli_auth_credentials_store = \"file\""]
        for s in servers {
            lines += ["", "[mcp_servers.\(s.name)]", "command = \(toml(s.command))", "args = [\(s.args.map(toml).joined(separator: ", "))]",
                      "env = { \(s.env.map { "\($0.0) = \(toml($0.1))" }.joined(separator: ", ")) }", "startup_timeout_sec = 30", "tool_timeout_sec = 90"]
        }
        let text = lines.joined(separator: "\n") + "\n"
        let file = (home as NSString).appendingPathComponent("config.toml")
        if (try? String(contentsOfFile: file, encoding: .utf8)) != text { try? writePrivate(file, text) }
    }

    // A closing line like the foot the app writes ("*Chat · Opus · high*"): a model copies one it saw (2026-10-13).
    static let copiedFootRE = JSRegex("^\\*(Chat|Brainstorm|Discover|Create|Build)( · [^*]*)?\\*$")

    /// The text without the copied feet it ends with, and the blank lines before them.
    public static func withoutCopiedFoot(_ text: String) -> String {
        let lines = text.components(separatedBy: "\n")
        var end = lines.count
        while end > 0 && (lines[end - 1].jsTrim.isEmpty || copiedFootRE.test(lines[end - 1].jsTrim)) { end -= 1 }
        if lines[end...].allSatisfy({ $0.jsTrim.isEmpty }) { return text }
        return lines[..<end].joined(separator: "\n")
    }

    /// Whether a reply's citations are checked: Chat's own answers, not a Build's, Brainstorm's, Discover's or Create's.
    public static func citesChecked(_ agent: String, _ routed: Routed?) -> Bool { agent == "bart" && routed?.build != true }

    /// The reply as the document keeps it, by agent.
    public static func replyBody(_ agent: String, _ text: String) -> String {
        let fencedOrJSON = JSRegex("^\\s*(\\{|```)").test(text)
        if agent == "brainstorm" && fencedOrJSON, let card = Card.readCard(text), card["card"]?.string != "none" {
            return Card.cardBody(topicsOnly(text)).body
        }
        if agent == "discover" {
            if fencedOrJSON, let card = Card.readCard(text), card["card"]?.string != "none" { return Card.cardBody(text).body }
            // A guide starts at its first "## " heading (round 2): a status line written before it is dropped.
            let lines = withoutCopiedFoot(text).components(separatedBy: "\n")
            if let at = lines.firstIndex(where: { $0.hasPrefix("## ") }), at > 0 { return lines[at...].joined(separator: "\n") }
            return lines.joined(separator: "\n")
        }
        return withoutCopiedFoot(text)
    }

    static let topicTagRE = JSRegex("<topic>([^<\\n]*)</topic>", "g")
    /// → the reply without its topic tags, and the last one's label as a title reads (or nil).
    public static func takeTopic(_ text: String?) -> (text: String, topic: String?) {
        let said = text ?? ""
        if !said.contains("<topic>") { return (said, nil) }
        var label: String? = nil
        let rest = JSRegex("\\s+$").replace(topicTagRE.replace(said) { m in label = m[1]; return "" }, with: "")
        let t = label.map { NameChat.capTitle(NameChat.plainTitle($0)) } ?? ""
        return (rest, t.isEmpty ? nil : t)
    }
    static let researchTagRE = JSRegex("<research>([\\s\\S]*?)</research>", "g")
    /// → the reply without its research tags, and the last one's direction on one line (or nil).
    public static func takeResearch(_ text: String?) -> (text: String, research: String?) {
        let said = text ?? ""
        if !said.contains("<research>") { return (said, nil) }
        var found: String? = nil
        let rest = JSRegex("\\s+$").replace(researchTagRE.replace(said) { m in found = m[1]; return "" }, with: "")
        let research = found.map { $0.squashedSpaces.jsSlice(0, 1000) } ?? ""
        return (rest, research.isEmpty ? nil : research)
    }

    /// An empty @discover line with nothing in the workspace to make a card of is asked this alone (2026-10-14).
    static let discoverQuestion = "What would you like to research?"
    static let openingTopics = 4

    /// A bare opening's reply: a card keeps its topics' labels only, at most four; a reply that asks the question is the
    /// question alone. Anything else, and any later turn, as it came.
    static func opened(_ plan: TurnPlan, _ text: String) -> String {
        if !plan.question.isEmpty { return text }
        if JSRegex("^\\s*(\\{|```)").test(text) { return topicsOnly(text) }
        return text.contains(discoverQuestion) ? discoverQuestion : text
    }
    static func topicsOnly(_ said: String) -> String {
        guard let card = Card.parseJson(said), let focus = card["focus"], focus.isObject, let options = focus["options"]?.array else { return said }
        let kept = options.compactMap { o -> OJ? in
            if let s = o.string { return s.isEmpty ? nil : ["label": .string(s)] }
            if o.isObject { let l = o["label"] ?? .null; if case .string(let s) = l, !s.isEmpty { return ["label": l] }; if case .number = l { return ["label": l] }; if case .bool(true) = l { return ["label": l] } }
            return nil
        }.prefix(openingTopics)
        return card.setting("focus", focus.setting("options", .array(Array(kept)))).stringify()
    }

    /// The reply with what it hands back taken out: a Brainstorm conversation's topic; the direction Discover settled on
    /// (which a search's own turn never hands back).
    static func taken(_ agent: String, _ plan: TurnPlan, _ text: String) -> (text: String, topic: String?, research: String?) {
        if agent == "brainstorm" && !plan.welcome { let t = takeTopic(text); return (t.text, t.topic, nil) }
        if agent == "discover" {
            let out = takeResearch(text)
            return (plan.search ? out.text : opened(plan, out.text), nil, plan.search ? nil : out.research)
        }
        return (text, nil, nil)
    }

    /// What the run log starts a run with (RunLog): what the agent is told, block by block, before its first step.
    public static func runRecord(id: String, agent: String, provider: String, projectId: String, question: String, system: String, context: BartContext,
                                 shown: [Turn], extra: String, mode: String?, pinned: Bool, routed: Routed?, place: OJ?, reply: Int?) -> OJ {
        var o: [(String, OJ)] = [("id", .string(id)), ("agent", .string(agent)), ("provider", .string(provider)), ("projectId", .string(projectId)),
                                 ("projectName", .string(context.project.name)), ("workspaceName", .string(context.workspaceName)), ("question", .string(question)),
                                 ("at", .number(Time.ms())), ("status", "running"), ("system", .string(system)), ("mode", mode.map { .string($0) } ?? .null), ("pinned", .bool(pinned))]
        if let reply, reply >= 0 { o.append(("reply", .number(Double(reply)))) }
        if let id = routed?.id { o.append(("routedFrom", .string(id))) }
        if let c = routed?.corrected { o.append(("corrected", .string(c))) }
        if let failed = routed?.failed { o.append(("routedBy", "error")); o.append(("routeError", failed.isEmpty ? .null : .string(failed))) }
        if let place { o.append(("place", place)) }
        o.append(("context", ["head": .string(context.head), "contextJson": .string(context.contextJson), "mentionedFiles": .string(context.mentionedFiles),
                              "documents": .string(context.documents), "now": .string(context.now), "conversation": .string(Context.conversationBlock(shown, agent: agent)),
                              "extra": .string(extra), "dirs": .array(context.dirs.map { .string($0) })]))
        o.append(("steps", .array([])))
        return .object(o)
    }

    /// @create's Claude Code permission rules: its read and web tools, and Write and Edit on `draft` and under it alone,
    /// written as Claude Code writes an absolute path in a rule ("//" then the path without its leading "/").
    public static func createRules(_ draft: String) -> String {
        let under = "/\((draft as NSString).standardizingPath)/**"
        return "\(claudeTools),Edit(\(under)),Write(\(under))"
    }

    /// @create's Codex settings: the workspace-write sandbox, its working directory the one writable root, no network.
    public static let createCodex = ["sandbox_mode=\"workspace-write\"", "sandbox_workspace_write.writable_roots=[]", "sandbox_workspace_write.exclude_slash_tmp=true",
                                     "sandbox_workspace_write.exclude_tmpdir_env_var=true", "sandbox_workspace_write.network_access=false", "approval_policy=\"never\""]
}

/// ask.cjs createThreads: the sessions that can still be resumed, by threadKey. `take` removes what it returns (a session
/// is either being continued or it is gone); `keep` starts the idle clock again. With `file`, what is held outlives the
/// app: a session id and when it was last used, nothing of what was said.
public final class Threads: @unchecked Sendable {
    public struct Entry: Equatable, Sendable {
        public var provider: String, session: String
        public var projectId: String?, workspaceId: String?
        public var at: Double
    }
    let idle: TimeInterval
    let file: URL?
    let now: () -> Double
    private var held: [(key: String, entry: Entry, timer: DispatchWorkItem)] = []
    private let lock = NSLock()

    public init(idle: TimeInterval = AskPlan.threadIdle, file: URL? = nil, now: @escaping () -> Double = { Time.ms() }) {
        self.idle = idle; self.file = file; self.now = now
        guard let file, let list = OJ.read(file)?.array else { return }
        for pair in list {
            guard let arr = pair.array, arr.count >= 2, let key = arr[0].string, arr[1].isObject,
                  let session = arr[1]["session"]?.string, let provider = arr[1]["provider"]?.string, let at = arr[1]["at"]?.double else { continue }
            let left = idle * 1000 - (now() - at)
            if left > 0 && left <= idle * 1000 {
                arm(key, Entry(provider: provider, session: session, projectId: arr[1]["projectId"]?.string, workspaceId: arr[1]["workspaceId"]?.string, at: at), left / 1000)
            }
        }
    }

    private func save() {
        guard let file else { return }
        let json: OJ = .array(held.map { h in
            var o: [(String, OJ)] = [("provider", .string(h.entry.provider)), ("session", .string(h.entry.session))]
            if let p = h.entry.projectId { o.append(("projectId", .string(p))) }
            if let w = h.entry.workspaceId { o.append(("workspaceId", .string(w))) }
            o.append(("at", .number(h.entry.at)))
            return [.string(h.key), .object(o)]
        })
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Files.writeAtomically(json.stringify(), to: file, mode: 0o600)
    }

    private func arm(_ key: String, _ entry: Entry, _ seconds: TimeInterval) {
        let timer = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.lock(); self.held.removeAll { $0.key == key && $0.entry == entry }; self.save(); self.lock.unlock()
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds, execute: timer)
        held.append((key, entry, timer))
    }

    private func drop(_ key: String) {
        if let i = held.firstIndex(where: { $0.key == key }) { held[i].timer.cancel(); held.remove(at: i) }
    }

    /// The session kept under `key` for `provider`, removed whatever it was.
    public func take(_ key: String, provider: String) -> Entry? {
        lock.lock(); defer { lock.unlock() }
        let entry = held.first { $0.key == key }?.entry
        drop(key)
        if entry != nil { save() }
        guard let entry, entry.provider == provider, !entry.session.isEmpty else { return nil }
        return entry
    }

    public func keep(_ key: String, provider: String, session: String, projectId: String?, workspaceId: String?) {
        lock.lock(); defer { lock.unlock() }
        drop(key)
        arm(key, Entry(provider: provider, session: session, projectId: projectId, workspaceId: workspaceId, at: now()), idle)
        save()
    }

    public func forget(_ match: (Entry) -> Bool = { _ in true }) {
        lock.lock(); defer { lock.unlock() }
        for h in held where match(h.entry) { drop(h.key) }
        save()
    }

    public var size: Int { lock.lock(); defer { lock.unlock() }; return held.count }
}
