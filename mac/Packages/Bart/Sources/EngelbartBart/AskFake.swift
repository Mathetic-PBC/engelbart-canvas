import Foundation
import EngelbartDoc
import EngelbartCore

// ask.cjs createFakeBart and its fakes — scripted runs only (ENGELBART_BART_FAKE=1): no model. A question containing
// "hard" moves up one step; one containing "code" is answered with a JSON code block too; "cite" adds two citations, one
// the check keeps and one it takes out. @brainstorm runs fakeThink (the Welcome walkthrough's fakeWelcome), @discover
// fakeDiscover, @create fakeCreate. Each streams like a real run: two things done, then the answer in pieces.

enum Fakes {
    static let wrapRE = JSRegex("\\bwrap(?:ping)? (?:it |this )?up\\b", "i")

    static func cardJSON(_ say: String, _ id: String, _ title: String, eyebrow: String) -> String {
        (["say": .string(say), "card": "questions", "questions": ["eyebrow": .string(eyebrow), "items": [["id": .string(id), "type": "open", "title": .string(title), "placeholder": "In your own words…"]]], "ready": false] as OJ).stringify()
    }
    static func focusJSON(_ title: String, _ labels: [String]) -> String {
        (["say": "", "card": "focus", "focus": ["title": .string(title), "options": .array(labels.map { ["label": .string($0)] })], "ready": false] as OJ).stringify()
    }

    /// The fake Welcome walkthrough's cards. A line containing "malformed" gets a reply that is not a card.
    static func welcome(_ plan: TurnPlan) -> String {
        if JSRegex("malformed", "i").test(plan.question) { return "FAKE REPLY that is not a card: {\"say\": \"cut off" }
        if plan.stage == "first" { return cardJSON("", AskPlan.workingID, AskPlan.workingTitle, eyebrow: "to start") }
        let first = plan.prior.count > 1 ? plan.prior[1].question.jsTrim : ""
        return cardJSON(first.isEmpty ? "" : "You started from “\(JSRegex("\\s+").split(first).prefix(6).joined(separator: " "))”.", CardBody.nextID, AskPlan.welcomeNextTitle, eyebrow: "what next")
    }

    /// The fake @brainstorm (2026-10-14: a conversation, in prose; its first turn the card, 2026-10-16).
    static func think(_ plan: TurnPlan, _ sent: String) -> String {
        let n = plan.prior.count, asked = plan.question.isEmpty ? CardBody.opening : plan.question
        let given = n == 0 ? "no earlier turns" : sent.contains("<conversation>") ? "a new session, given \(n) earlier \(n == 1 ? "turn" : "turns")" : "the same session, given the question alone"
        if n == 0 && !wrapRE.test(asked) {
            let title = asked == CardBody.opening ? "What would you like to talk about?" : "Where would you like to start with “\(asked.jsSlice(0, 80))”?"
            let labels = asked == CardBody.opening ? ["Fake theme one", "Fake theme two", "Fake theme three"] : ["A fake first angle", "A fake second angle", "A fake third angle"]
            return focusJSON(title, labels)
        }
        if wrapRE.test(asked) { return "FAKE BRAINSTORM wrap-up after \(n) \(n == 1 ? "turn" : "turns") (\(given)).\n\nWhat became clearer: what you said. Still open: the rest." }
        return "FAKE BRAINSTORM on \"\(asked)\" (\(given)).\n\nWhat part of that matters most to you?"
    }

    /// The fake @brainstorm's topic: a conversation with none yet takes what the person said; "New topic: X" takes X.
    static func topic(_ reply: String, _ sent: String, _ question: String) -> String {
        if JSRegex("^\\s*\\{").test(reply) { return reply }
        let asked = question.jsTrim
        let now = JSRegex("<topic>([^<]*)</topic>").match(sent)?[1] ?? ""
        let changed = JSRegex("^New topic:\\s*(.+)$", "i").match(asked), picked = JSRegex("^picked \"([^\"]+)\"").match(asked)
        let label = changed?[1] ?? (now.isEmpty && !asked.isEmpty && asked != "(skipped)" && !wrapRE.test(asked) ? (picked?[1] ?? asked) : "")
        return !label.isEmpty && label != now ? "\(reply)\n\n<topic>\(label)</topic>" : reply
    }

    /// A fake Chat answer's citations, when the question says "cite" (2026-10-21).
    static func citations(_ context: BartContext) -> String {
        guard let note = context.entries.first(where: { e in e.path.map { JSRegex("\\.md$", "i").test($0) && FileManager.default.fileExists(atPath: $0) } ?? false }),
              let text = try? String(contentsOfFile: note.path!, encoding: .utf8) else { return "" }
        let words = JSRegex("\\s+").split(JSRegex("[#*_`>\\[\\]()-]", "g").replace(text, with: " ")).filter { !$0.isEmpty }.prefix(6).joined(separator: " ")
        if words.components(separatedBy: " ").count < 4 { return "" }
        let good = PassageLink.citeHref(address: note.path!, find: words, cite: "you")
        let bad = PassageLink.citeHref(address: note.path!, find: "words the fake note never says anywhere", cite: "you")
        return "\n\nYou wrote this down before [You · Oct 12](\(good)). And something else [You · Oct 13](\(bad))."
    }

    static let unclearRE = JSRegex("\\b(?:not sure|something else|different)\\b", "i")
    static let clearRE = JSRegex("\\b(?:find|papers?|studies|study|overview|survey|literature|just search|explore)\\b|@\\[", "i")

    /// The fake @discover's turn that settles what to research.
    static func direction(_ plan: TurnPlan) -> String {
        let said = plan.question.jsTrim, opening = said.isEmpty || said == AskPlan.discoverOpening
        if opening { return focusJSON("What would you like to research?", ["Fake theme one", "Fake theme two", "Fake theme three"]) }
        let lastGuide = plan.prior.lastIndex { $0.answer.hasPrefix("## ") } ?? -1
        let asked = plan.prior.dropFirst(lastGuide + 1).filter { !$0.question.isEmpty && $0.question != AskPlan.discoverOpening && !AskPlan.isSearch($0.question) }
        func unpick(_ q: String) -> String { JSRegex("^picked \"([^\"]+)\"$").replace(q) { $0[1] ?? "" } }
        if plan.refine && unclearRE.test(said) { return "FAKE DISCOVER: What should the search look at instead?" }
        if plan.refining { return "FAKE DISCOVER will now look for work on “\(said)”.\n\n<research>\(said)</research>" }
        let picked = said.hasPrefix("picked \"")
        if asked.isEmpty && lastGuide < 0 && (picked || !clearRE.test(said)) {
            return picked ? "FAKE DISCOVER: What are you hoping to understand about \(unpick(said).lowercased())?" : "FAKE DISCOVER: What are you hoping the research will help you figure out?"
        }
        let direction = (asked.map { unpick($0.question) } + [unpick(said)]).joined(separator: "; ")
        return "FAKE DISCOVER will look for work on “\(direction)”.\n\n<research>\(direction)</research>"
    }

    /// The fake @discover's reply: the direction first, in conversation; a search writes a guide of fake entries.
    static func discover(_ context: BartContext, _ plan: TurnPlan) -> String {
        if !plan.search { return direction(plan) }
        let guided = plan.prior.contains { JSRegex("^## ").test($0.answer) }
        let mode = plan.mode ?? "standard"
        func why(_ gives: String) -> String { "**Why:** Helps you examine a fake \(gives) bearing on how to tell the work is going well." }
        func entry(_ title: String, _ address: String, _ section: String?, _ words: String, _ to: String, _ gives: String = "method") -> [String] {
            ["**[\(title)](\(address))** · Fake Author et al. · 2024",
             "**Read:** \(section.map { "[\($0)](\(address)#find=\(encodeURIComponent(words))\(to.isEmpty ? "" : "&to=\(encodeURIComponent(to))"))" } ?? "abstract only")",
             why(gives)]
        }
        func essay(_ title: String, _ address: String, _ heading: String, _ words: String, _ gives: String) -> [String] {
            ["**[\(title)](\(address))** · Fake Essayist · undated", "**Read:** [\(heading)](\(address)#find=\(encodeURIComponent(words)))", why(gives)]
        }
        func where_(_ e: CatalogEntryView) -> String { e.path.map { $0.components(separatedBy: "/").map(encodeURIComponent).joined(separator: "/") } ?? e.url ?? "" }
        func classic(_ label: String) -> [String] { entry("A fake classic\(label) (\(mode) mode)", "https://example.org/fake-classic", "Implementation", "a fake passage on how it was built", "the fake evaluation after it", "term for what is being handled") }
        let essays = ["## Essays", ""] + essay("A fake essay", "https://example.org/fake-essay", "A fake heading", "the fake first paragraph of the essay", "case that cuts against what is assumed")
        if let m = JSRegex("@\\[([^\\]\\n]+)\\](?!\\(ws:)").match(plan.question), let name = m[1] {
            let item = context.entries.first { $0.name == name && ($0.path != nil || $0.url != nil) }
            let address = item.map(where_) ?? "https://example.org/fake-named-paper.pdf"
            func pair(_ section: String, _ words: String, _ to: String, _ gives: String) -> [String] {
                ["**Read:** [\(section)](\(address)#find=\(encodeURIComponent(words))&to=\(encodeURIComponent(to)))", why(gives)]
            }
            return (["## This paper", "", "**[\(name)](\(address))** · Fake Author et al. · 2024"]
                    + pair("5 Findings", "a fake passage on what was found", "the fake discussion after it", "measurement")
                    + pair("3 Method", "a fake passage on how it was done", "the fake findings after it", "method") + [""]
                    + ["## Classics", ""] + classic(" it cites") + [""]
                    + ["## Recent", ""] + entry("A fake paper that cites it", "https://example.org/fake-recent", "Study", "a fake passage on its study", "the fake results after it", "design to compare against") + [""]
                    + essays).joined(separator: "\n")
        }
        if guided { return (["## Recent", ""] + entry("A fake later paper", "https://example.org/fake-recent", nil, "", "", "measurement")).joined(separator: "\n") }
        let own = plan.prior.count > 1 ? plan.question.jsTrim : ""
        let first = context.entries.first { $0.type == "pdf" && ($0.path != nil || $0.url != nil) } ?? context.entries.first { $0.path != nil || $0.url != nil }
        var lines = ["## Start here", ""]
        if !own.isEmpty { lines += entry("A fake record for “\(own.jsSlice(0, 80))”", "https://example.org/fake-named", nil, "", "", "design to compare against") + [""] }
        lines += (first.map { entry($0.name, where_($0), "Introduction", "a fake passage the fake did not read", "the fake section after it") }
                  ?? entry("A fake starting paper", "https://example.org/fake-start.pdf", "Introduction", "a fake passage", "the fake section after it")) + [""]
        lines += ["## Classics", ""] + classic("") + [""] + essays
        return lines.joined(separator: "\n")
    }

    /// The fake @create's run: a sentence, files written in its draft folder, then "Done."; a request to change something
    /// it has gets no file and the one sentence that it is a Build.
    static func create(_ draft: String, _ question: String) -> (first: String, files: [String], last: String) {
        if JSRegex("\\b(?:build|change|fix|rename|edit|delete|remove)\\b|\\bmake (?:the|my)\\b[^.]*\\bdifferent\\b", "i").test(question) {
            return ("", [], "This is a Build: it changes something you already have, so I made nothing.")
        }
        let rows = [(2021, 3), (2022, 5), (2023, 4), (2024, 7)]
        let bars = rows.enumerated().map { at, r in "<rect x=\"\(20 + at * 60)\" y=\"\(150 - r.1 * 18)\" width=\"40\" height=\"\(r.1 * 18)\" fill=\"#4a6fa5\"><title>\(r.0): \(r.1)</title></rect><text x=\"\(40 + at * 60)\" y=\"168\" text-anchor=\"middle\">\(r.0)</text>" }.joined()
        let t = JSRegex("[<>&\"]", "g").replace(question, with: "").jsTrim.jsSlice(0, 80)
        let title = t.isEmpty ? "Fake chart" : t
        func write(_ name: String, _ text: String) { try? text.write(toFile: (draft as NSString).appendingPathComponent(name), atomically: true, encoding: .utf8) }
        write("report.md", "# Fake report\n\nA fake report for “\(title)”. Nothing was read: every number here is fake.\n")
        write("chart.html", "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>\(title)</title><style>body{font:14px system-ui;margin:24px}text{font-size:11px}</style></head>\n<body><h1>\(title)</h1><svg width=\"280\" height=\"180\" role=\"img\" aria-label=\"fake bars\">\(bars)</svg><p id=\"n\"></p><script>document.getElementById('n').textContent = 'Fake data, drawn by the page itself.';</script></body></html>\n")
        write("data.csv", "year,count\n\(rows.map { "\($0.0),\($0.1)" }.joined(separator: "\n"))\n")
        return ("A fake report, a chart page and its data, from made-up numbers.", ["report.md", "chart.html", "data.csv"], "Done.")
    }

    /// The paper tools' calls and answers a fake @discover search tells as its trace, as Claude Code's events.
    static func traceEvents(_ entries: [CatalogEntryView]) -> [JSONValue] {
        let theirs = entries.first { $0.type == "pdf" || $0.tags.contains("paper") }
        let own: OJ = ["id": "W1", "title": .string(theirs?.name ?? "A fake paper of yours"), "doi": .null]
        let found: OJ = ["id": "W2", "title": "A fake paper close to the problem", "doi": .null]
        func use(_ id: String, _ name: String, _ input: OJ) -> JSONValue { (["type": "assistant", "message": ["content": [["type": "tool_use", "id": .string(id), "name": .string("mcp__papers__\(name)"), "input": input]]]] as OJ).jsonValue }
        func back(_ id: String, _ value: OJ) -> JSONValue { (["type": "user", "message": ["content": [["type": "tool_result", "tool_use_id": .string(id), "content": [["type": "text", "text": .string(value.stringify())]]]]]] as OJ).jsonValue }
        let more: [OJ] = (0..<11).map { ["id": .string("W\(10 + $0)"), "title": .string("Fake result \($0 + 2)")] }
        return [
            use("f1", "resolve", ["query": own["title"]!]), back("f1", ["found": true, "paper": own]),
            use("f2", "search", ["query": "The fake problem, in a sentence."]), back("f2", ["total": 12, "order": "closest in meaning first (title and abstract)", "results": .array([found] + more)]),
            use("f3", "resolve", ["query": "W2"]), back("f3", ["found": true, "paper": found]),
            use("f4", "references", ["id": "W1"]), back("f4", ["of": own, "total": 14, "listed": 14, "results": []]),
            use("f5", "references", ["id": "W2"]), back("f5", ["of": found, "total": 22, "listed": 22, "results": []]),
            use("f6", "citations", ["id": "W1"]), back("f6", ["of": own, "total": 3, "results": []]),
        ]
    }
}

extension Bart {
    /// A pause a Stop cuts short (the fake's `waits`).
    static func fakePause(_ ms: Double, _ stopper: AgentShell.Stopper) async throws {
        var left = ms
        while left > 0 {
            if stopper.isStopped { throw BartError.stopped }
            let step = min(left, 10)
            try? await Task.sleep(nanoseconds: UInt64(step * 1_000_000))
            left -= step
        }
        if stopper.isStopped { throw BartError.stopped }
    }

    func fakeAsk(store: BartStore, projectId: String, _ q: AskRequest, onProgress: @escaping @Sendable (BartProgress) -> Void) async throws -> AskAnswer {
        let models = config.readModels()
        let agent = q.agent
        let context = try await Context.build(store: store, projectId: projectId, ref: q.ref, workspaceId: q.workspaceId, askId: q.askId, agent: agent,
                                              highlight: q.highlight, stage: q.stage, live: q.live, overleaf: q.overleaf)
        let plan = AskPlan.turnPlan(agent: agent, text: q.text, turns: q.turns, choice: q.choice, welcome: Bart.welcomeHere(store, projectId, agent, q.ref, q.workspaceId), models: models)
        let discover = agent == "discover", create = agent == "create", question = plan.question
        if plan.pinned && !question.isEmpty && agent == "bart" { remember(plan.steps[0]) }
        let threads = threadsFor(agent)
        let held = !plan.prior.isEmpty && threads != nil && !AskPlan.switched(plan.prior, agent) ? threads!.take(AskPlan.threadKey(projectId, q.ref, plan.prior), provider: plan.provider) : nil
        let logId = q.askId.isEmpty ? IDs.new() : q.askId, started = Time.ms()
        log?.start(AskPlan.runRecord(id: logId, agent: agent, provider: plan.provider, projectId: projectId, question: q.text, system: AskPlan.loadSystemPrompt(store.dataRoot, agent: agent),
                                     context: context, shown: plan.shown, extra: plan.extra, mode: plan.mode, pinned: plan.pinned, routed: q.routed, place: q.place, reply: plan.prior.count))
        if let corrected = q.routed?.corrected { RouteModel.markCorrected(log, id: q.routed?.id, projectId: projectId, text: q.text, agent: corrected) }
        func ended(_ status: String, _ result: AskAnswer?, _ error: Error?) {
            log?.finish(logId, status: status, written: result?.lines, error: error.map { ($0 as? BartError)?.message ?? $0.localizedDescription }, ms: Time.ms() - started)
        }
        if plan.written != nil { let r = Bart.resultReply(plan); ended("done", r, nil); return r }
        if create && question.isEmpty { let e = BartError("failed", "There is nothing on the line to make."); ended("failed", nil, e); throw e }
        let message = AskPlan.firstMessage(context: context, prior: plan.shown, question: await Bart.withImagePaths(store, projectId, plan.asked), resumed: held != nil,
                                           extra: plan.extra, routed: q.routed, agent: agent, topic: agent == "brainstorm" ? context.topic : nil)
        // A reply under a running search stops it first (the real ask's pausedFor).
        if let steer = q.steer { stop(steer.after) }
        let (stopper, gate) = register(q.askId)
        let feed = Feed(intervalMs: 0) { onProgress($0) }
        let delay = config.fakeDelayMs
        func act(_ text: String) async throws -> String {
            feed.reset()
            // Discover looks papers up only when it searches (2026-10-14); settling what to research, it reads the notes.
            let doing = discover ? (plan.search ? ["Reading notes.md", "Looking up “fake”", "Reading what cites “fake”"] : ["Reading notes.md"])
                : ["Reading notes.md", AskPlan.quiet.contains(agent) ? "Searching for “fake”" : "Searching the web for “fake”"]
            for a in doing { feed.take(.activity(a, log: true)); try await Bart.fakePause(delay / 4, stopper) }
            if discover && plan.search {
                let trace = Trace(entries: context.entries)
                for event in Fakes.traceEvents(context.entries) { if let story = trace.take(event) { onProgress(.trace(story)) }; try await Bart.fakePause(delay / 16, stopper) }
            }
            feed.take(.textStart)
            let pieces = JSRegex("[\\s\\S]{1,24}", "g").matchAll(text).map { $0.whole }
            for d in pieces { feed.take(.delta(d)); try await Bart.fakePause(delay / 2 / Double(pieces.count), stopper) }
            return text
        }
        var line = ""
        func actCreate(_ run: (first: String, files: [String], last: String)) async throws -> String {
            feed.reset()
            line = run.first
            if !run.first.isEmpty { onProgress(.making(run.first)) }
            feed.take(.activity("Reading notes.md", log: true)); try await Bart.fakePause(delay / 4, stopper)
            for file in run.files {
                feed.take(.activity("Writing \(file)", log: false)); feed.take(.activity("Writing \(file) · 2 KB", log: false)); try await Bart.fakePause(delay / 8, stopper)
                feed.take(.activity("Writing \(file)", log: true)); try await Bart.fakePause(delay / 8, stopper)
            }
            feed.take(.textStart)
            let pieces = JSRegex("[\\s\\S]{1,24}", "g").matchAll(run.last).map { $0.whole }
            for d in pieces { feed.take(.delta(d)); try await Bart.fakePause(delay / 4 / Double(pieces.count), stopper) }
            return run.last
        }
        let draft = create ? try Create.openDraft(store.dataRoot, logId) : nil
        defer { feed.end(); unregister(q.askId, gate); Create.dropDraft(draft) }
        do {
            let steps = plan.steps, prior = plan.prior
            let out = try await AskPlan.climb(steps: steps, pinned: plan.pinned, first: message, session: held?.session, onProgress: onProgress, quiet: AskPlan.quiet.contains(agent)) { [self] level, sent, _ in
                log?.step(logId, model: level.model, name: level.name, effort: level.effort, input: sent)
                let text: String
                if create { text = try await actCreate(Fakes.create(draft!, question)) }
                else if plan.welcome { text = try await act(Fakes.welcome(plan)) }
                else if agent == "brainstorm" { text = try await act(Fakes.topic(Fakes.think(plan, sent), sent, question)) }
                else if discover { text = try await act(Fakes.discover(context, plan)) }
                else if question.contains("hard") && sent.contains("step 1 of") { text = try await act("ESCALATE: the question says it is hard") }
                else {
                    var answer = "FAKE ANSWER to \"\(question)\".\n\n## Seen\n- **\(context.documents.jsLength)** characters of documents\n- `\(steps.count)` steps"
                    if !prior.isEmpty {
                        let n = prior.count
                        answer += "\n- " + (sent.contains("<conversation>") ? "a new session, given \(n) earlier \(n == 1 ? "turn" : "turns")" : sent.contains("<engelbart>") ? "a new session, given no earlier turns" : "the same session, given the question alone")
                    }
                    if question.contains("code") { answer += "\n\nThe same as JSON:\n\n```json\n{\n  \"fake\": true,\n  \"steps\": \(steps.count),\n  \"note\": \"# not a heading\"\n}\n```" }
                    if JSRegex("\\bcite\\b").test(question) { answer += Fakes.citations(context) }
                    text = try await act(answer)
                }
                let t = text.jsTrim
                log?.output(logId, raw: text, escalated: t.jsLength < 500 && AskPlan.escalateRE.test(t))
                return (text, "fake")
            }
            var meta = ReplyMeta(provider: plan.provider, level: .init(name: out.level.name, effort: out.level.effort, model: out.level.model), trail: out.trail, ms: out.ms, pinned: plan.pinned, routed: q.routed)
            var made: Kept? = nil
            if create, let draft {
                let k = try Create.keepCreated(projectDir: context.project.dir, askId: logId, draft: draft)
                made = k
                meta.created = k.files.map { CreatedRow(name: $0.name, type: $0.type, path: $0.rel) }
                log?.amend(logId, [("created", .array(meta.created!.map { ["name": .string($0.name), "type": .string($0.type), "path": .string($0.path)] })), ("skipped", .array(k.skipped.map { .string($0) }))])
                if let library = config.createdLibrary { await Create.saveAllCreated(projectDir: context.project.dir, projectId: projectId, workspaceId: q.workspaceId, askId: logId, files: k.files, library: library) }
            }
            let named = AskPlan.taken(agent, plan, out.text)
            let body: String
            if let made { body = Create.createdBody(Create.createdSentence(made.files.isEmpty ? "" : Making.createdLine(line.isEmpty ? Create.requestSentence(question) : line), out.text, question), made, logId) }
            else if plan.welcome { body = CardBody.cardBody(AskPlan.welcomeReply(out.text, stage: plan.stage)).body }
            else { body = await citedBody(store: store, agent: agent, routed: q.routed, body: AskPlan.replyBody(agent, named.text), projectId: projectId, workspaceId: q.workspaceId, prior: plan.prior, question: q.text, logId: logId, context: nil, events: []) }
            threads?.keep(AskPlan.threadKey(projectId, q.ref, plan.prior + [AskPlan.cleanTurn(AskTurn(question: q.text, answer: Reply.answerText(body)))]), provider: plan.provider, session: out.session ?? "fake", projectId: projectId, workspaceId: q.workspaceId)
            let result = AskAnswer(lines: Reply.replyLines(body, meta, model: !AskPlan.quiet.contains(agent), agent: agent), meta: meta, topic: named.topic, research: named.research, welcome: nil)
            ended("done", result, nil)
            return result
        } catch {
            ended((error as? BartError)?.kind == "stopped" ? "stopped" : "failed", nil, error)
            throw error
        }
    }
}
