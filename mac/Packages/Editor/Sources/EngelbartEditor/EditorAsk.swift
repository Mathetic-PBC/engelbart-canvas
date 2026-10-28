import Foundation
import EngelbartCore
import EngelbartDoc

// @bart and the conversations it makes (DocEditor.jsx: askInline, routeLine, handOff, regenerate, edit mode, folding,
// titles, follow-ups, research boxes).

extension EditorCore {
    /// The agents that run on one model of their own (no chip) and may be asked with nothing after them.
    static func oneModel(_ agent: String) -> Bool { agent != "bart" && agent != "create" }
    /// A conversation Discover started: nothing in it collapses by itself (2026-10-15, David).
    static func discoverThread(_ t: DocThread) -> Bool { t.asked == "discover" || t.routedTo == "discover" || t.turns.first?.agent == "discover" }
    static let RESEARCH_WAIT_S = 5
    static let FOLLOW_AGENTS: Set<String> = ["brainstorm", "discover"]

    public func findTurn(_ ls: [String], _ q: Int) -> (thread: DocThread, turn: Turn)? {
        for t in threads(ls) { if let turn = t.turns.first(where: { $0.q == q }) { return (t, turn) } }
        return nil
    }

    /// The agent a turn is with: the one its lines name, else, for an `@bart` line at work, the one Bart handed it to.
    public func turnAgent(_ thread: DocThread, _ turn: Turn?) -> String {
        if let a = turn?.agent { return a }
        if let id = turn?.pending, let a = asks[id]?.agent, ["bart", "brainstorm", "discover"].contains(a) { return a }
        return thread.agent
    }

    /// The turns of the card above question `q` as the document holds them: what a follow-up is a follow-up to.
    public func turnsBefore(_ ls: [String], _ q: Int) -> [AskedTurn] {
        guard let found = findTurn(ls, q) else { return [] }
        return found.thread.turns.filter { $0.q < q && $0.answered && $0.pending == nil }.map { t in
            let said = Doc.turnText(ls, t); return AskedTurn(question: said.question, answer: said.answer, agent: t.agent)
        }
    }

    /// Whether line `i` stands right under the last line of an answered conversation not at work (its question then starts its own).
    func underCard(_ ls: [String], _ i: Int) -> Bool {
        i > 0 && threads(ls).contains { t in
            guard let last = t.turns.last else { return false }
            return t.to == i - 1 && last.answered && last.build == nil && !t.turns.contains { $0.pending != nil }
        }
    }

    /// Whether the question on line `i` starts a conversation that takes a title.
    func startsTitled(_ ls: [String], _ i: Int, _ turns: [AskedTurn]) -> Bool {
        if !turns.isEmpty { return false }
        if findTurn(ls, i)?.thread.turns.contains(where: { $0.q < i }) == true { return false }
        let ps = Doc.parseLines(ls)
        return !(i > 0 && ps[i - 1].type == .title)
    }

    /// A question refining a search still running in its conversation stops it: its pending line says so.
    func refining(_ ls: [String], _ q: Int) -> [String] {
        var out = ls
        let ps = Doc.parseLines(ls)
        guard let thread = Doc.threads(ls, ps).first(where: { $0.from <= q && q <= $0.to }) else { return out }
        for turn in thread.turns where turn.q < q && turn.pending != nil && Doc.isResearch(ps[turn.q]) {
            guard let at = ls.firstIndex(of: "bart~> \(turn.pending!)") else { continue }
            out[at] = "bart> Stopped: refined below."
            stopRun(turn.pending!)
        }
        return out
    }

    func refiningIn(_ ls: [String], _ thread: DocThread, before: Int = Int.max) -> Bool {
        let ps = Doc.parseLines(ls)
        let turns = thread.turns.filter { $0.q < before }
        let ran = turns.lastIndex { Doc.isResearch(ps[$0.q]) && ($0.answered || $0.pending != nil) } ?? -1
        return turns.suffix(from: ran + 1).contains { Doc.isRefine(ps[$0.q]) }
    }
    func refiningAt(_ ls: [String], _ q: Int) -> Bool { findTurn(ls, q).map { refiningIn(ls, $0.thread, before: q) } ?? false }

    /// A run stopped from the document: a countdown is cancelled, a run at work is stopped.
    public func stopRun(_ askId: String) {
        if waits.removeValue(forKey: askId) != nil { return }
        hooks.stopAsk(askId)
    }

    // MARK: asking a line

    /// Enter on a question line (askInline): its pending line under it, a title line above a question that starts a
    /// conversation, the window asked. An `@bart` line goes to the router.
    public func askInline(_ i: Int) {
        if let e = editing, e.q == i { commitEdit(); return }
        let ls = lines
        guard i >= 0 && i < ls.count else { return }
        let p = Doc.parseLine(ls[i]), agent = Doc.agentOf(p)
        guard p.type == .bart, !p.text.trimmed.isEmpty || EditorCore.oneModel(agent), let ask = hooks.ask, !lockedAt(ls, i), !readOnly else { return }
        if agent == "router" { routeLine(i); return }
        // A line typed right under a card's last answer starts a conversation of its own: an empty line goes in above it.
        let gap = underCard(ls, i), at = gap ? i + 1 : i
        var gapped = ls; if gap { gapped.insert("", at: i) }
        let askId = EditorText.newAskId()
        var add = ["bart~> \(askId)"]
        let turns = turnsBefore(gapped, at)
        if at + 1 >= gapped.count { add.append("") }
        let name = startsTitled(gapped, at, turns), build = Question.buildRequestOf(agent: agent, text: p.text) != nil
        hooks.asked(askId)
        setLines { x in
            var out = gap ? Array(x[..<i]) + [""] + Array(x[i...]) : x
            out = self.refining(out, at)
            out.insert(contentsOf: add, at: at + 1)
            if name { out.insert(Doc.titleLine("", folded: false, meta: TitleMeta(text: "", agent: agent, at: Doc.askedNow(), build: build)), at: at) }
            return out
        }
        activeLine = nil
        var req = AskRequest(askId: askId, text: p.text.trimmed, turns: turns, agent: agent, placeLine: name ? at + 1 : at, placeText: ls[i])
        req.name = name
        ask(req)
    }

    /// What a line's pending row names while Bart routes it: the first step of the agent it goes to if he cannot pick.
    func routingLevel(_ ls: [String], _ q: Int, _ text: String, _ agent: String) -> (name: String, effort: String)? {
        guard let models else { return nil }
        if agent == "brainstorm" || agent == "build" { return nil }
        let step = agent == "discover" ? discoverRead(ls, q).steps.first : Question.readQuestion(text, models).steps.first
        return step.map { ($0.name, $0.effort) }
    }

    /// Bart, the router: an `@bart` line gets its pending line, its agent by rule or from the model, and is handed over.
    /// `line`: an `@bart` line put in at `i` first (sendFollow), in the same change; `before`: a change made with it.
    public func routeLine(_ i: Int, line: String? = nil, before: (([String]) -> [String])? = nil) {
        let now = lines
        let gap = line == nil && underCard(now, i)
        let put: String? = line ?? (gap ? "" : nil)
        var ls = now; if let put { ls.insert(put, at: i) }
        let q = gap ? i + 1 : i
        let p = Doc.parseLine(q < ls.count ? ls[q] : "")
        let askId = EditorText.newAskId()
        var add = ["bart~> \(askId)"]; if q + 1 >= ls.count { add.append("") }
        let key = docKey
        let inputs = Route.routeInputs(ls, q)
        let rule = Route.routeByRule(p.text, asking: inputs.asking)
        hooks.asked(askId)
        setLines { x in var out = before?(x) ?? x; if let put { out.insert(put, at: i) }; out.insert(contentsOf: add, at: q + 1); return out }
        activeLine = nil
        let fallback = rule.map { RoutePick(agent: $0.agent, sure: 1, by: "rule", rule: $0.rule) } ?? RoutePick(agent: Route.fallbackAgent(inputs.current), sure: 0, by: "none")
        var req = RouteRequest(askId: askId, text: p.text.trimmed, inputs: inputs, rule: rule, placeLine: q, placeText: ls[q])
        req.level = routingLevel(ls, q, p.text, fallback.agent)
        if let route = hooks.route {
            route(req) { [weak self] pick in self?.handOff(askId, pick ?? RoutePick(agent: Route.fallbackAgent(inputs.current)), key: key) }
        } else {
            handOff(askId, fallback, key: key)
        }
    }

    func linesOf(_ key: String) -> [String]? { key == docKey ? lines : hooks.docTextOf(key)?.jsSplit("\n") }
    func setLinesOf(_ key: String, _ fn: ([String]) -> [String]) {
        if key == docKey { setLines(nil, fn); return }
        if let ls = linesOf(key) { hooks.changeDoc(key, fn(ls).joined(separator: "\n")) }
    }

    /// Where Bart's pick goes (handOff): asked of that agent, the pick kept on the title line; a spec built; a `--build` line built.
    @discardableResult
    public func handOff(_ askId: String, _ pick: RoutePick, key: String? = nil) -> String? {
        let key = key ?? docKey
        let ls = linesOf(key) ?? []
        guard let pendingAt = ls.firstIndex(of: "bart~> \(askId)"), pendingAt >= 1 else { hooks.routeGone(askId); return nil }
        let q = pendingAt - 1, p = Doc.parseLine(ls[q])
        guard p.type == .bart, Doc.agentOf(p) == "router", let ask = hooks.ask else { hooks.routeGone(askId); return nil }
        let text = p.text.trimmed, typedText = ls[q]
        var routed: [String: JSONValue] = ["id": pick.id.map { .string($0) } ?? .null]
        if pick.by == "error" { routed["by"] = "error"; if let e = pick.error { routed["error"] = .string(String(e.prefix(400))) } }
        if pick.agent == "build" && pick.rule == "--build" {
            let name = startsTitled(ls, q, turnsBefore(ls, q))
            if name { setLinesOf(key) { x in var out = x; if let at = out.firstIndex(of: "bart~> \(askId)"), at > 0 { out.insert(Doc.titleLine("", folded: false, meta: TitleMeta(text: "", agent: "bart", at: Doc.askedNow(), build: true)), at: at - 1) }; return out } }
            var req = AskRequest(askId: askId, text: text, turns: [], agent: "router", placeLine: name ? q + 1 : q, placeText: typedText)
            req.routed = .object(routed); req.name = name
            ask(req)
            return "build"
        }
        if pick.agent == "build", let spec = Route.routeInputs(ls, q).spec, pick.spec, pick.sure >= 0.8, let build = hooks.build {
            build(BuildRequest(text: spec, askId: askId, routedFrom: pick.id, after: nil, afterLine: nil, placeLine: q, placeText: typedText))
            return "build"
        }
        let agent = ["brainstorm", "discover", "create"].contains(pick.agent) ? pick.agent : "bart", build = pick.agent == "build"
        let turns = turnsBefore(ls, q)
        let ps = Doc.parseLines(ls)
        let above = q > 0 ? ps[q - 1] : nil
        let meta = TitleMeta(text: "", agent: agent, at: Doc.askedNow(), build: build)
        var next = ls, name = false
        if !turns.isEmpty { next = ls }
        else if let above, above.type == .title { next[q - 1] = Doc.titleLine(above.text, folded: above.folded, meta: meta) }
        else if startsTitled(ls, q, turns) { next.insert(Doc.titleLine("", folded: false, meta: meta), at: q); name = true }
        else { next[q] = "@\(Doc.tokenOf(agent))\(p.text.isEmpty ? "" : " \(p.text)")" }
        let at2 = name ? q + 1 : q
        if agent == "discover" { next = refining(next, at2) }
        if next != ls { let n = next; setLinesOf(key) { _ in n } }
        let refine = agent == "discover" && refiningAt(next, at2)
        if build { routed["build"] = true }
        var req = AskRequest(askId: askId, text: text, turns: turns, agent: agent, placeLine: at2, placeText: typedText)
        req.routed = .object(routed); req.name = name; req.refine = refine
        ask(req)
        return agent
    }

    // MARK: research boxes

    /// A research box's state: ready, running, interrupted, stopped, failed, finished.
    public func boxState(_ ls: [String], _ turn: Turn) -> String {
        if let id = turn.pending { return asks[id] != nil || waits[id] != nil ? "running" : "interrupted" }
        if !turn.answered { return "ready" }
        let said = Doc.parseLine(turn.from < ls.count ? ls[turn.from] : "").text.trimmed
        return said == "Stopped." ? "stopped" : Rx(#"^\*\*No answer\.\*\*"#).test(said) ? "failed" : "finished"
    }

    func discoverRead(_ ls: [String], _ i: Int) -> Question.Read {
        Question.readDiscover(Doc.parseLine(i < ls.count ? ls[i] : "").text, models ?? .defaults, earlier: turnsBefore(ls, i).map { $0.question })
    }

    /// An @discover line's chip: its level ("Standard"), with its provider when not the default ("Codex · Deep"), or the pin.
    public func discoverLabel(_ i: Int) -> String {
        let m = models ?? .defaults
        let read = discoverRead(lines, i), step = read.steps[0]
        if read.pinned { return "\(step.name) \(Question.EFFORT_LABELS[step.effort] ?? step.effort)" }
        let level = ["quick": "Quick", "standard": "Standard", "deep": "Deep"][read.mode ?? "standard"] ?? "Standard"
        return read.provider == m.provider ? level : "\(m.entry(read.provider)?.name ?? read.provider) · \(level)"
    }

    /// A research box's search asked of Discover; a Deep one after RESEARCH_WAIT_S seconds, counting down.
    func askResearch(_ ask: AskRequest) {
        var full = ask; full.agent = "discover"; full.research = true
        let mode = models.map { Question.readDiscover(ask.text, $0, earlier: ask.turns.map { $0.question }).mode }
        if mode == "deep" { waitResearch(full) } else { hooks.ask?(full) }
    }
    func waitResearch(_ ask: AskRequest) {
        waits[ask.askId] = (ask, EditorCore.RESEARCH_WAIT_S)
        let key = docKey
        func tick() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                guard let self, let held = self.waits[ask.askId] else { return }
                if !(self.linesOf(key) ?? []).contains("bart~> \(ask.askId)") { self.waits[ask.askId] = nil; self.hooks.routeGone(ask.askId); return }
                if held.left <= 1 { self.waits[ask.askId] = nil; self.hooks.ask?(held.ask); self.hooks.changed(self.text); return }
                self.waits[ask.askId] = (held.ask, held.left - 1)
                self.hooks.changed(self.text)
                tick()
            }
        }
        tick()
    }
    /// Cancel on a Deep box counting down: the box is taken out, nothing is searched.
    @discardableResult
    public func cancelWait(_ askId: String) -> Bool {
        guard waits.removeValue(forKey: askId) != nil else { return false }
        let ls = lines
        if let at = ls.firstIndex(of: "bart~> \(askId)"), at > 0, Doc.isResearch(Doc.parseLines(ls)[at - 1]) {
            setLines { x in x.enumerated().filter { $0.offset != at - 1 && $0.offset != at }.map { $0.element } }
        }
        return true
    }
    public func startResearch(_ i: Int) {
        let ls = lines
        guard let found = findTurn(ls, i), Doc.isResearch(Doc.parseLines(ls)[i]), !found.turn.answered, found.turn.pending == nil, hooks.ask != nil else { return }
        let askId = EditorText.newAskId(), turns = turnsBefore(ls, i)
        setLines { x in var out = x; if out[i] != ls[i] { return out }; out.insert("bart~> \(askId)", at: i + 1); if i + 2 >= out.count { out.append("") }; return out }
        askResearch(AskRequest(askId: askId, text: Doc.parseLine(ls[i]).text.trimmed, turns: turns, agent: "discover", placeLine: i, placeText: ls[i]))
    }
    public func restartResearch(_ i: Int) {
        let ls = lines
        guard let found = findTurn(ls, i), Doc.isResearch(Doc.parseLines(ls)[i]), hooks.ask != nil, !readOnly else { return }
        let state = boxState(ls, found.turn)
        if state == "running" { return }
        if state == "ready" { startResearch(i); return }
        let askId = EditorText.newAskId(), turns = turnsBefore(ls, i), to = max(i, found.turn.to)
        setLines { x in var out = x; if out[i] != ls[i] { return out }; out.replaceSubrange((i + 1)...to, with: ["bart~> \(askId)"]); if i + 2 >= out.count { out.append("") }; return out }
        activeLine = nil
        askResearch(AskRequest(askId: askId, text: Doc.parseLine(ls[i]).text.trimmed, turns: turns, agent: "discover", placeLine: i, placeText: ls[i]))
    }

    // MARK: follow-ups

    /// The flags a follow-up carries: the model picked under its chip, else the last question's.
    func followStep(_ ls: [String], _ thread: DocThread) -> (flags: String, step: Question.Step?) {
        guard let models, let last = thread.turns.last else { return ("", nil) }
        let lastText = Doc.parseLine(ls[last.q]).text
        let flags: String
        if let c = followChoice[thread.from], Question.modelOf(c.model, models) != nil { flags = "--\(c.model) --\(c.effort)" }
        else { flags = Question.readFlags(lastText, models).spans.map { lastText.slice($0[0], $0[1]) }.joined(separator: " ") }
        return (flags, Question.readQuestion(flags, models).steps.first)
    }

    /// `ls` with the answers of `turns` collapsed or expanded, each turn's reply lines `bart+>`.
    static func foldTurns(_ ls: [String], _ turns: [Turn], to: Bool = true) -> [String] {
        ls.enumerated().map { j, l in
            guard turns.contains(where: { $0.answered && $0.pending == nil && j >= $0.from && j <= $0.to }) else { return l }
            let p = Doc.parseLine(l)
            return p.type == .reply && p.folded != to ? Doc.replyLine(p.text, to).trimEnd : l
        }
    }
    /// A turn asked under a conversation: the two newest stay open, older ones collapse (2026-10-14, David).
    static func foldOlder(_ ls: [String], _ turns: [Turn]) -> [String] { foldTurns(ls, Array(turns.dropLast())) }

    /// A follow-up sent from the reply field under conversation `from` (sendFollow): an `@bart` line routed (with a router),
    /// else a line of the conversation's agent, under its last answer, the older turns collapsed in the same edit.
    public func sendFollow(_ from: Int) {
        let ls = lines
        guard let thread = threads(ls).first(where: { $0.from == from }), let ask = hooks.ask, let end = thread.turns.last else { return }
        let ps = parsed(ls)
        // Under a research box not started yet, or cut short, what is typed adjusts its plan: a Refine; running, it steers.
        if Doc.isResearch(ps[end.q]) {
            let state = boxState(ls, end)
            if state == "ready" || state == "interrupted" { sendRefine(from); return }
            if state == "running" { steerResearch(from); return }
        }
        let typed = (followText[from] ?? "").trimmed
        var agent = Doc.answeredBy(thread)
        if !end.answered || end.pending != nil || typed.isEmpty { return }
        let text = EditorText.withAttachments(typed, followImages[from] ?? [])
        // What is typed may start by naming an agent: `@brainstorm …` is asked of it as it stands, never routed.
        let named = Rx(#"^@(bart|chat|brainstorm|orient|discover|create)(?=\s|$)\s*"#, "i").match(text)
        let token = named?[1]?.lowercased()
        let own = token != nil && token != "bart", said = named.map { text.slice($0.str.len) } ?? text
        let flags = own ? "" : followStep(ls, thread).flags
        let asked = [flags, said].filter { !$0.isEmpty }.joined(separator: " ")
        followText[from] = nil; followImages[from] = nil
        let routed = !own && hooks.route != nil
        let question = routed ? "@bart \(asked)" : own ? "@\(token!) \(asked)".trimEnd : "@\(Doc.tokenOf(agent)) \(asked)".trimEnd
        if own { agent = Doc.agentOf(Doc.parseLine(question)) }
        let discovering = EditorCore.discoverThread(thread)
        let fold: ([String]) -> [String] = { x in discovering ? x : EditorCore.foldOlder(x, thread.turns) }
        if routed { routeLine(thread.to + 1, line: question, before: fold); return }
        let askId = EditorText.newAskId()
        var add = [question, "bart~> \(askId)"]; if thread.to + 1 >= ls.count { add.append("") }
        let turns = thread.turns.filter { $0.answered && $0.pending == nil }.map { t -> AskedTurn in let s = Doc.turnText(ls, t); return AskedTurn(question: s.question, answer: s.answer, agent: t.agent) }
        hooks.asked(askId)
        setLines { x in var out = fold(x); out.insert(contentsOf: add, at: thread.to + 1); return out }
        activeLine = nil
        var req = AskRequest(askId: askId, text: asked, turns: turns, agent: agent, placeLine: thread.to + 1, placeText: add[0])
        req.refine = agent == "discover" && refiningIn(ls, thread)
        ask(req)
    }

    /// What is typed under a research box at work: the search goes on with it (`--steer <words>` on the box's line).
    func steerResearch(_ from: Int) {
        let ls = lines
        guard let thread = threads(ls).first(where: { $0.from == from }), let box = thread.turns.last, box.pending != nil, hooks.ask != nil else { return }
        let words = Rx(#"\s+"#).replace(followText[from] ?? "", with: " ").trimmed
        if words.isEmpty { return }
        followText[from] = nil; followImages[from] = nil
        steerBox(ls, box, "\(ls[box.q].trimEnd) --steer \(words)", steer: ["words": .string(words)])
    }
    func steerBox(_ ls: [String], _ box: Turn, _ line: String, steer: [String: JSONValue]) {
        let i = box.q, after = box.pending!, text = Doc.parseLine(line).text.trimmed
        if var held = waits[after] {
            held.ask.text = text; held.ask.placeLine = i; held.ask.placeText = line; waits[after] = held
            setLines { x in x.enumerated().map { $0.offset == i ? line : $0.element } }
            return
        }
        let askId = EditorText.newAskId(), at = ls.firstIndex(of: "bart~> \(after)") ?? -1
        setLines { x in x.enumerated().map { $0.offset == i ? line : $0.offset == at ? "bart~> \(askId)" : $0.element } }
        activeLine = nil
        var req = AskRequest(askId: askId, text: text, turns: turnsBefore(ls, i), agent: "discover", placeLine: i, placeText: line)
        req.research = true
        var s = steer; s["after"] = .string(after); req.steer = .object(s)
        hooks.ask?(req)
    }

    /// Refine: the conversation's next turn, `@discover --refine <words>`; a search at work stops and its box goes.
    func sendRefine(_ from: Int) {
        let ls = lines
        guard let thread = threads(ls).first(where: { $0.from == from }), let ask = hooks.ask else { return }
        let typed = (followText[from] ?? "").trimmed
        if typed.isEmpty { return }
        let text = EditorText.withAttachments(typed, followImages[from] ?? []), question = Doc.refineLine(text), askId = EditorText.newAskId()
        followText[from] = nil; followImages[from] = nil
        let ps = Doc.parseLines(ls)
        var gone = Set<Int>()
        for turn in thread.turns where Doc.isResearch(ps[turn.q]) && !(turn.answered && turn.pending == nil) {
            if let id = turn.pending, boxState(ls, turn) == "running" { stopRun(id) }
            for j in turn.q...turn.to { gone.insert(j) }
        }
        var next = ls.enumerated().filter { !gone.contains($0.offset) }.map { $0.element }
        let at = (Doc.threads(next).first { $0.from == from } ?? thread).to + 1
        next.insert(contentsOf: [question, "bart~> \(askId)"], at: at); if at + 2 >= next.count { next.append("") }
        let turns = turnsBefore(next, at)
        hooks.asked(askId)
        let n = next
        setLines { _ in n }
        activeLine = nil
        var req = AskRequest(askId: askId, text: "--refine \(text)", turns: turns, agent: "discover", placeLine: at, placeText: question)
        req.refine = true
        ask(req)
    }

    // MARK: Regenerate and edit mode

    static let VIA = Rx(#"(?:^| · )via Bart( · build)?$"#)
    static let LEAD = Rx(#"^(Chat|Brainstorm|Discover|Create|Build)(?: · |$)"#)

    /// What answered turn `q`, read from its closing line; the question's own first step when there is none.
    public func ranWith(_ ls: [String], _ q: Int) -> (current: (provider: String, model: String, effort: String)?, choice: (model: String, effort: String)?) {
        guard let models, let found = findTurn(ls, q) else { return (nil, nil) }
        let said = found.turn.foot >= 0 ? Doc.parseLine(ls[found.turn.foot]).text.slice(1, -1) : ""
        if !said.isEmpty {
            let parts = EditorCore.LEAD.replace(said, with: "", global: false).components(separatedBy: " · ")
            let name = parts.first ?? "", effort = parts.count > 1 ? Question.effortOf(parts[1]) : nil
            if let effort { for p in models.providers { for m in p.models where m.name == name { return ((p.key, m.key, effort), (m.key, effort)) } } }
        }
        let step = Question.readQuestion(Doc.parseLine(ls[q]).text, models).steps[0]
        return ((step.provider, step.key, step.effort), nil)
    }

    /// Regenerate: the answer gives way to a pending line and the question is asked again. `edited`: an edited question's
    /// lines and the undo step to go back to.
    @discardableResult
    public func regenerate(_ q: Int, choice: (model: String, effort: String)? = nil, edited: (lines: [String], undo: (text: String, mark: Int))? = nil, routed routedIn: JSONValue? = nil, as asAgent: String? = nil) -> String? {
        let ls = edited?.lines ?? lines
        guard let found = findTurn(ls, q), found.turn.pending == nil, found.turn.build == nil, let ask = hooks.ask else { return nil }
        let (thread, turn) = found
        let p = Doc.parseLine(ls[q])
        let agent = Doc.agentOf(p) == "router" ? (asAgent ?? turnAgent(thread, turn)) : Doc.agentOf(p)
        if p.text.trimmed.isEmpty && !EditorCore.oneModel(agent) { return nil }
        let was = edited != nil ? lines : ls
        let oldFoot = findTurn(was, q)
        let footText = oldFoot.map { $0.turn.foot >= 0 ? Doc.parseLine(was[$0.turn.foot]).text : "" } ?? ""
        let saidFoot = Rx(#"^\*|\*$"#).replace(footText, with: "")
        let via = EditorCore.VIA.match(saidFoot), lead = EditorCore.LEAD.match(saidFoot)?[1]
        var routing = routedIn
        if routing == nil {
            if let via { routing = .object(["build": .bool(via[1] != nil)]) }
            else if Doc.agentOf(p) == "router" && (thread.routedTo != nil || lead != nil) { routing = .object(["build": .bool(lead == "Build" || (thread.build && q == thread.from))]) }
        }
        let askId = EditorText.newAskId(), gone = turn.to - turn.q, turns = turnsBefore(ls, q)
        var out = ls; out.replaceSubrange(turn.from..<(turn.from + gone), with: ["bart~> \(askId)"])
        if let edited { setDoc(out.joined(separator: "\n"), undo: edited.undo) } else { setDoc(out.joined(separator: "\n")) }
        activeLine = nil
        var req = AskRequest(askId: askId, text: p.text.trimmed, turns: turns, agent: agent, placeLine: q, placeText: ls[q])
        if let choice, let models, Question.modelOf(choice.model, models) != nil { req.choice = choice }
        req.routed = routing
        ask(req)
        return askId
    }

    /// Edit (2026-10-03): an answered turn's question becomes an ordinary agent line again, its answer dimmed under it.
    public func startEdit(_ q: Int) {
        if let e = editing, e.q != q { cancelEdit() }
        let ls = lines
        if editing == nil {
            guard let found = findTurn(ls, q), canEdit(Doc.parseLine(ls[q]), found.turn) else { return }
            editing = Editing(q: q, original: ls[q], under: Array(ls[found.turn.from...found.turn.to]), mark: history.count)
        }
        caret = CaretPlace(line: q, offset: ls[q].len)
        activeLine = q
    }
    func canEdit(_ p: ParsedLine, _ turn: Turn) -> Bool {
        hooks.ask != nil && !readOnly && turn.answered && turn.pending == nil && !Doc.isResearch(p) && Question.buildRequestOf(agent: Doc.agentOf(p), text: p.text) == nil
    }
    /// Out of edit mode with the question as it was; what was typed into it leaves the document and undo.
    public func cancelEdit() {
        guard let was = editing else { return }
        editing = nil
        history.removeSubrange(min(history.count, was.mark)...)
        var ls = lines
        if was.q < ls.count && ls[was.q] != was.original { ls[was.q] = was.original; text = ls.joined(separator: "\n"); hooks.changed(text) }
        if activeLine == was.q { activeLine = nil }
    }
    /// Enter on the question being edited: unchanged, edit mode ends; changed, the turns after it go and it is asked
    /// again as Regenerate asks it. One undo brings all of it back.
    public func commitEdit() {
        guard let was = editing else { return }
        let ls = lines, q = was.q, line = q < ls.count ? ls[q] : ""
        if line == was.original { cancelEdit(); return }
        let p = Doc.parseLine(line), found = findTurn(ls, q)
        let agent = Doc.agentOf(p) == "router" && found != nil ? turnAgent(found!.thread, found!.turn) : Doc.agentOf(p)
        if p.type != .bart || Doc.agentOf(p) != Doc.agentOf(Doc.parseLine(was.original)) || Question.buildRequestOf(agent: Doc.agentOf(p), text: p.text) != nil || (p.text.trimmed.isEmpty && !EditorCore.oneModel(agent)) { return }
        guard let found, found.turn.pending == nil, hooks.ask != nil else { return }
        let later = found.thread.turns.filter { $0.q > q }
        let next = later.isEmpty ? ls : Array(ls[..<later[0].q]) + Array(ls[(found.thread.to + 1)...])
        func flags(_ l: String) -> String { let t = Doc.parseLine(l).text; return models.map { m in Question.readFlags(t, m).spans.map { t.slice($0[0], $0[1]) }.joined(separator: " ") } ?? "" }
        let choice = EditorCore.oneModel(agent) || flags(line) != flags(was.original) ? nil : ranWith(ls, q).choice
        for turn in later { if let id = turn.pending { hooks.stopAsk(id) } }
        editing = nil
        var undoLines = ls; undoLines[q] = was.original
        regenerate(q, choice: choice, edited: (next, (undoLines.joined(separator: "\n"), was.mark)))
    }
    /// The document changed under a question being edited: found again by its answer, under the nearest question line.
    func trackEdit() {
        guard let was = editing else { return }
        let ls = lines, ps = parsed(ls), n = was.under.count
        func holds(_ j: Int) -> Bool { j + n < ls.count && was.under.enumerated().allSatisfy { ls[j + 1 + $0.offset] == $0.element } }
        if holds(was.q) { return }
        var q = -1
        for j in ls.indices where ps[j].type == .bart && holds(j) && (q < 0 || abs(j - was.q) < abs(q - was.q)) { q = j }
        if q < 0 { editing = nil; return }
        editing!.q = q
        if activeLine == was.q { activeLine = q; caret = CaretPlace(line: q, offset: ls[q].len) }
    }
    /// A question left being edited when its document goes: it goes back as it was, in that document.
    func dropEdit() {
        guard let was = editing else { return }
        editing = nil
        var ls = lines
        if was.q < ls.count && ls[was.q] != was.original { ls[was.q] = was.original; text = ls.joined(separator: "\n"); hooks.changed(text) }
    }

    // MARK: folding

    /// Collapse / Expand one turn: the fold is on every reply line of it (`bart+>`).
    public func toggleFold(_ q: Int) {
        let ls = lines
        guard let found = findTurn(ls, q), found.turn.answered else { return }
        let turn = found.turn, to = !turn.folded
        setLines { x in x.enumerated().map { j, l in
            guard j >= turn.from && j <= turn.to else { return l }
            let p = Doc.parseLine(l); return p.type == .reply ? Doc.replyLine(p.text, to).trimEnd : l
        } }
        activeLine = nil
    }
    /// Whether `turn`'s Collapse collapses its whole conversation: the first exchange of a titled one, open, nothing at work.
    public func collapsesThread(_ thread: DocThread, _ turn: Turn) -> Bool {
        guard let first = thread.turns.first else { return false }
        return first.q == turn.q && !turn.folded && thread.titleLine >= 0 && !isRunning(thread)
    }
    public func collapseTurn(_ q: Int) {
        guard let found = findTurn(lines, q) else { return }
        if collapsesThread(found.thread, found.turn) { toggleThread(found.thread.titleLine) } else { toggleFold(q) }
    }
    /// A conversation's Collapse: a titled one collapses whole; otherwise each answered exchange folds.
    public func collapseAll(_ q: Int) {
        guard let found = findTurn(lines, q) else { return }
        if found.thread.titleLine >= 0 && !isBuilding(found.thread) { toggleThread(found.thread.titleLine); return }
        setLines { x in EditorCore.foldTurns(x, found.thread.turns) }
        activeLine = nil
    }
    /// A titled conversation collapses whole to its title's row (`bart#+`), and expands; one a Build works on stays open.
    public func toggleThread(_ line: Int) {
        let ls = lines
        guard let thread = threads(ls).first(where: { $0.titleLine == line }) else { return }
        if !thread.folded && isBuilding(thread) { return }
        let head = parsed(ls)[line]
        setLines { x in x.enumerated().map { $0.offset == line ? Doc.titleLine(thread.title ?? "", folded: !thread.folded, meta: TitleMeta(text: head.text, agent: head.agent, at: head.at, build: head.build)).trimEnd : $0.element } }
        activeLine = nil
    }
    /// Coming back to a document: titled conversations left open collapse, all but those at work or not answered; once
    /// per docKey, and a conversation answered by a Build only once its Build's record is known (autoWait).
    public func autoCollapse() {
        guard autoCollapseOn, !readOnly else { return }
        let first = autoFolded != docKey
        if !first { guard let w = autoWait, w.docKey == docKey, w.ids.contains(where: { builds[$0] != nil }) else { return } }
        if first { autoFolded = docKey; autoWait = (docKey, []) }
        let ls = lines, ps = Doc.parseLines(ls)
        var titles: [Int: String] = [:]
        for thread in Doc.threads(ls, ps) {
            if thread.titleLine < 0 || thread.folded || !thread.turns.contains(where: { $0.answered }) { continue }
            let ids = thread.turns.compactMap { $0.build }, unknown = ids.filter { builds[$0] == nil }
            if !unknown.isEmpty { if first { for id in unknown { autoWait!.ids.insert(id) } }; continue }
            if !first { if !ids.contains(where: { autoWait!.ids.contains($0) }) { continue }; for id in ids { autoWait!.ids.remove(id) } }
            if !isRunning(thread) { titles[thread.titleLine] = thread.title ?? "" }
        }
        if !first { for id in autoWait!.ids where builds[id] != nil { autoWait!.ids.remove(id) } }
        if !titles.isEmpty {
            text = ls.enumerated().map { j, l in titles[j].map { Doc.titleLine($0, folded: true, meta: TitleMeta(text: "", agent: ps[j].agent, at: ps[j].at, build: ps[j].build)).trimEnd } ?? l }.joined(separator: "\n")
            hooks.changed(text)
        }
    }
    /// Collapse all / Expand all: every titled conversation by its title, every other answered turn by its lines.
    public func foldable() -> [(title: Int?, turn: Turn?, folded: Bool)] {
        var out: [(Int?, Turn?, Bool)] = []
        for thread in threads(lines) {
            if thread.titleLine >= 0 {
                if thread.folded || (!isRunning(thread) && thread.turns.contains { $0.answered }) { out.append((thread.titleLine, nil, thread.folded)) }
                continue
            }
            for turn in thread.turns where turn.answered && turn.pending == nil && turn.build == nil { out.append((nil, turn, turn.folded)) }
        }
        return out
    }
    public func foldAll(_ to: Bool) {
        let items = foldable(); if items.isEmpty { return }
        let ls = lines
        let inTitled = to ? [] : threads(ls).filter { $0.titleLine >= 0 }.flatMap { $0.turns.filter { $0.answered && $0.pending == nil && $0.build == nil } }
        let turns = items.compactMap { $0.turn } + inTitled
        let titles = Set(items.compactMap { $0.title })
        setLines { x in x.enumerated().map { j, l in
            if titles.contains(j) { let p = Doc.parseLine(l); return p.type == .title && p.folded != to ? Doc.titleLine(p.text, folded: to, meta: TitleMeta(text: "", agent: p.agent, at: p.at, build: p.build)).trimEnd : l }
            guard turns.contains(where: { j >= $0.from && j <= $0.to }) else { return l }
            let p = Doc.parseLine(l); return p.type == .reply && p.folded != to ? Doc.replyLine(p.text, to).trimEnd : l
        } }
        activeLine = nil
    }

    /// A conversation renamed (its collapsed row's field): an empty name or the same name changes nothing.
    public func commitTitle(_ line: Int, _ typed: String) {
        let t = Doc.flattenPaste(typed), ls = lines
        guard line < ls.count else { return }
        let p = parsed(ls)[line]
        guard !t.isEmpty, p.type == .title, t != p.text.trimmed else { return }
        setLines { x in x.enumerated().map { $0.offset == line ? Doc.titleLine(t, folded: p.folded, meta: TitleMeta(text: "", agent: p.agent, at: p.at, build: p.build)) : $0.element } }
    }

    /// Delete: the turn leaves the document (its run stopped); the last turn of a titled conversation takes its title too.
    public func deleteTurn(_ q: Int) {
        guard let found = findTurn(lines, q) else { return }
        let (thread, turn) = found
        if let id = turn.pending { hooks.stopAsk(id) }
        let from = thread.turns.count == 1 && thread.titleLine >= 0 ? thread.titleLine : turn.q
        setLines { x in let out = x.enumerated().filter { $0.offset < from || $0.offset > turn.to }.map { $0.element }; return out.isEmpty ? [""] : out }
        activeLine = nil
    }

    /// Copy on a turn: the question as asked (no flags) and the answer as written (no prefixes, no closing line).
    public func copyText(_ q: Int) -> String {
        let ls = lines
        guard let found = findTurn(ls, q) else { return "" }
        let t = Doc.turnText(ls, found.turn)
        let question = models.map { Question.readFlags(t.question, $0).rest } ?? t.question
        return [question, t.answer].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    /// The footer's Build: the turn's last fenced block, else its question and answer, built after the conversation.
    @discardableResult
    public func footBuild(_ q: Int) -> Bool {
        let ls = lines
        guard let found = findTurn(ls, q), found.turn.answered, found.turn.pending == nil, !found.thread.turns.contains(where: { $0.pending != nil }), let build = hooks.build else { return false }
        build(BuildRequest(text: Route.buildTextOf(ls, found.turn), askId: nil, routedFrom: nil, after: found.thread.to, afterLine: ls[found.thread.to], placeLine: q, placeText: ls[q]))
        return true
    }

    // MARK: the chip and the menu

    /// How a question line starts as written ("@Chat" from the menu, "@chat" typed).
    static func leadOf(_ line: String, _ agent: String) -> String {
        let token = Doc.tokenOf(agent)
        return Rx("^@\(token)", "i").match(line)?.str ?? "@\(token)"
    }
    /// A model and effort picked under a line's chip: written into the line as its flags.
    public func pickModel(line i: Int, model: String, effort: String) {
        guard let models else { return }
        let ls = lines
        guard i < ls.count else { return }
        let p = Doc.parseLine(ls[i])
        guard p.type == .bart, !lockedAt(ls, i) else { return }
        let t = Question.withChoice(p.text, models, model: model, effort: effort)
        let line = "\(EditorCore.leadOf(ls[i], Doc.agentOf(p))) \(t)\(Question.readFlags(t, models).rest.isEmpty ? " " : "")"
        setLines(activeLine == i ? CaretPlace(line: i, offset: line.len) : nil) { x in x.enumerated().map { $0.offset == i ? line : $0.element } }
    }
    /// A level picked under an @discover line's chip, on a provider; the plain level and provider are written as none.
    public func pickLevel(line i: Int, mode: String, provider: String?) {
        guard let models else { return }
        let ls = lines
        guard i < ls.count else { return }
        let p = Doc.parseLine(ls[i]), found = findTurn(ls, i)
        let box = found.flatMap { $0.turn.q == i && Doc.isResearch(Doc.parseLines(ls)[i]) ? $0.turn : nil }
        guard p.type == .bart, Doc.agentOf(p) == "discover", !lockedAt(ls, i) || box != nil else { return }
        let plain = Question.readDiscover("", models, earlier: turnsBefore(ls, i).map { $0.question })
        let t = Question.withMode(p.text, mode, models, plainMode: plain.mode ?? "standard", plainProvider: plain.provider, provider: provider ?? plain.provider)
        let line = "\(EditorCore.leadOf(ls[i], "discover")) \(t)\(!t.isEmpty && Question.readDiscover(t, models).question.isEmpty ? " " : "")"
        if let box, boxState(ls, box) == "running" {
            func runs(_ r: Question.Read) -> String { [r.mode ?? "", r.provider, r.steps[0].model, r.steps[0].effort].joined(separator: " ") }
            if runs(discoverRead(ls, i)) != runs(Question.readDiscover(Doc.parseLine(line).text, models, earlier: turnsBefore(ls, i).map { $0.question })) {
                steerBox(ls, box, line, steer: ["level": true])
            }
            return
        }
        setLines(activeLine == i ? CaretPlace(line: i, offset: line.len) : nil) { x in x.enumerated().map { $0.offset == i ? line : $0.element } }
    }

    /// A row of the @ menu picked on line `i`, its query from `start` to `caret`: a verb is written with a space after it;
    /// anything else as its mention token, and its row comes into the workspace.
    public func pickMention(line i: Int, start: Int, caretAt: Int, row r: MenuItem) {
        let ls = lines
        guard i < ls.count else { return }
        let cur = lineText(ls, i)
        let verbs = ["bart": "@Bart ", "chat": "@Chat ", "brainstorm": "@Brainstorm ", "discover": "@Discover ", "create": "@Create ", "note": "@Note "]
        let verb: String? = r.kind == .verb ? r.id.isEmpty ? r.key.replacingOccurrences(of: "verb:", with: "") : r.id : (["bart", "chat", "brainstorm", "discover", "create"].contains(r.id) ? r.id : nil)
        let ins = verb.flatMap { verbs[$0] } ?? Mention.mentionToken(r)
        writeText(i, cur.slice(0, start) + ins + cur.slice(caretAt), caret: CaretPlace(line: i, offset: start + ins.len))
        activeLine = i
        if verb == nil && r.kind != .workspace {
            let picked = (r.kind == .entry || r.kind == .self) && r.row != nil ? (r.zotero != nil ? nil : Mention.menuItem(r.row!)) : r
            if let picked { hooks.mentionPicked(picked) }
        }
    }

    /// The caret on the line under a card, made first if it is not there (gapAt's `add`), one undo step.
    public func openGap(at: Int, add: Bool) {
        if add { setLines { x in var out = x; out.insert("", at: min(at, out.count)); return out } }
        caret = CaretPlace(line: at, offset: 0)
        activeLine = at
    }

    /// A click past the last line: the caret at the end, or on a new line after a card.
    public func focusEnd() {
        let ls = lines, last = ls.count - 1
        if endsOnCard(ls) { setLines { x in x + [""] }; caret = CaretPlace(line: last + 1, offset: 0); activeLine = last + 1; return }
        caret = CaretPlace(line: last, offset: lineText(ls, last).len); activeLine = last
    }

    /// The walkthrough's Brainstorm: `@<agent>` on its own line at the end, after a blank line, asked at once.
    @discardableResult
    public func startAgent(_ agent: String) -> Bool {
        guard let ask = hooks.ask, EditorCore.oneModel(agent) else { return false }
        let ls = lines
        var end = ls.count
        while end > 0 && ls[end - 1].trimmed.isEmpty { end -= 1 }
        let askId = EditorText.newAskId(), token = "@\(Doc.tokenOf(agent))"
        let add = (end > 0 ? [""] : []) + [token, "bart~> \(askId)", ""]
        setLines { x in Array(x[..<end]) + add }
        activeLine = nil
        ask(AskRequest(askId: askId, text: "", turns: [], agent: agent, placeLine: end > 0 ? end + 1 : 0, placeText: token))
        return true
    }

    /// A research box the window put under Discover's reply: asked as one the editor put there. False until both lines are in.
    @discardableResult
    public func askBoxed(_ askId: String) -> Bool {
        let ls = lines
        guard let at = ls.firstIndex(of: "bart~> \(askId)"), at >= 1, hooks.ask != nil else { return false }
        let p = Doc.parseLine(ls[at - 1])
        guard Doc.isResearch(p) else { return false }
        askResearch(AskRequest(askId: askId, text: p.text.trimmed, turns: turnsBefore(ls, at - 1), agent: "discover", placeLine: at - 1, placeText: ls[at - 1]))
        return true
    }
}
