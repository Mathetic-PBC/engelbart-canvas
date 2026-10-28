import Foundation
import EngelbartCore
import EngelbartDoc
import EngelbartEditor

// Workspace.jsx "@bart": a question leaves the editor as { askId, text } with a pending line `bart~> <askId>` already under
// it. The agent reads the documents from disk, so everything is saved first. Its answer replaces the pending line in
// whatever that document's text is by then, open or not; Stop removes the line; progress shows on the pending row. Also
// the router (routeLine), Builds started from a line (buildFromEditor), and questions from a pdf's highlight or a web
// page's box (askHighlight, MATH-27 / MATH-70).
extension WorkspaceModel {
    /// What the @bart line's chip offers: read at start, when the window comes forward, after an ask, on models-changed.
    public func loadBartModels() {
        let api = self.api
        Task { @MainActor [weak self] in
            if let m = try? await api.bartModels(), let self, self.live { self.bartModels = m; self.changed() }
        }
    }
    public var questionModels: QuestionModels? { bartModels.flatMap { QuestionModels(json: $0) } }

    /// The runs' rows as the editors draw them.
    public var askProgress: [String: AskProgress] { asks.mapValues(\.progress) }

    /// A run begins or is handed on (DocEditor askStarted): merged, so a routed line keeps the level it was sent at.
    func askStarted(_ askId: String, docKey: String?, agent: String) {
        var run = asks[askId] ?? AskRun(docKey: docKey, at: Date(), progress: AskProgress(agent: agent))
        run.docKey = docKey
        run.progress.agent = agent
        if run.at == nil { run.at = Date() }
        asks[askId] = run
        changed()
    }
    func askEnded(_ askId: String) { if asks.removeValue(forKey: askId) != nil { changed() } }

    /// engelbart:bart-progress: a step begins (what the last step showed is dropped), what the agent is doing, the answer
    /// so far. Kept here and for the Stage's paper asks; never in the document.
    func onBartProgress(_ p: JSONValue) {
        guard let askId = p["askId"]?.string else { return }
        let step = p["step"] != nil && p["step"]?.isNull == false
        if var run = asks[askId] {
            run.progress = run.progress.progressed(step: step, name: p["name"]?.string, effort: p["effort"]?.string, movedUp: p["movedUp"]?.bool,
                                                   activity: p["activity"]?.string, lines: p["lines"]?.array?.compactMap(\.string), log: p["log"]?.bool == true)
            asks[askId] = run
            changed()
        }
        if var held = paperAsks[askId]?.object {
            if step { held["activity"] = ""; held["lines"] = .array([]) }
            for key in ["step", "name", "effort", "movedUp", "activity", "lines"] { if let v = p[key] { held[key] = v } }
            if p["log"]?.bool == true, let a = p["activity"] { held["log"] = .array(Array(((held["log"]?.array ?? []) + [a]).suffix(60))) }
            paperAsks[askId] = .object(held)
            changed()
        }
    }

    /// The text of the document `key` now (open in any pane or read before).
    func text(_ key: String) -> String? { docs[key] }

    /// Writes `lines` in place of `askId`'s pending line, in whatever the document says now.
    func placeLines(_ key: String, _ ref: PaneRef, _ askId: String, _ lines: [String], answered: inout (question: String, index: Int)?) {
        guard let held = docs[key] else { return }
        answered = Doc.askedAt(held, askId) ?? answered
        if let next = Doc.placeAnswer(held, askId, lines) { changeDoc(key, ref, next) }
    }

    /// An ask from a pane's editor (Workspace.jsx askBart). `key`/`ref`: the pane it was written in.
    public func askBart(key: String, ref: PaneRef, _ q: AskRequest) async {
        guard let topic else { return }
        let askedIn = topic.id
        let askId = q.askId
        var answered: (question: String, index: Int)? = nil
        let workspaceId = ref.workspaceId ?? topic.id
        askStarted(askId, docKey: key, agent: q.agent)
        if q.agent == "brainstorm" { tickWalk(2) }
        if q.agent == "discover" { tickWalk(3) }
        // `@bart --build <request>` (2026-10-02): not a question. A full Build of what follows the flag starts, and its card
        // takes the pending line's place, under the request.
        if bartModels == nil { bartModels = try? await api.bartModels() }
        let buildRequest = Question.buildRequestOf(agent: q.agent, text: q.text, questionModels)
        let later = q.name && buildRequest == nil && q.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let ownTopic = q.agent == "brainstorm" && buildRequest == nil
        let ownDirection = q.agent == "discover" && buildRequest == nil

        // The answer is in the document a render after it is placed: the title changes once it is there.
        func retitleTo(_ title: String, unset: Bool = false) {
            let near = answered
            retry(every: 0.1, tries: 20) { [weak self] in
                guard let self, let held = self.docs[key], !held.contains("bart~> \(askId)") else { return false }
                if let next = Doc.retitle(held, near: near, title, unset: unset) { self.changeDoc(key, ref, next) }
                return true
            }
        }
        func nameAs(_ said: String) {
            let input: JSONValue = buildRequest != nil ? ["text": .string(buildRequest!.isEmpty ? q.text : buildRequest!), "agent": "bart"] : ["text": .string(said), "agent": .string(q.agent)]
            let api = self.api
            Task { @MainActor [weak self] in
                guard let title = try? await api.nameChat(input) else { return }
                self?.retry(every: 0.1, tries: 20) { [weak self] in
                    guard let self, let held = self.docs[key], let next = Doc.placeTitle(held, askId, title, near: answered) else { return false }
                    self.changeDoc(key, ref, next)
                    return true
                }
            }
        }
        func nameDirection(_ said: String) {
            let api = self.api
            Task { @MainActor in
                guard let title = try? await api.nameChat(["text": .string(said), "agent": "discover"]) else { return }
                retitleTo(title, unset: true)
            }
        }
        if q.name && !later && !ownTopic { nameAs(q.text) }

        if let request = buildRequest {
            defer { askEnded(askId) }
            if request.isEmpty { placeLines(key, ref, askId, ["bart> **No Build.** Write what to build after --build."], answered: &answered); return }
            do {
                let task = try await buildFrom(ref: ref, text: request, routedFrom: q.routed?["id"]?.string, place: (q.placeLine, q.placeText))
                placeLines(key, ref, askId, [Doc.buildLine(task["id"]?.string ?? "")], answered: &answered)
            } catch {
                placeLines(key, ref, askId, ["bart> **No Build.** \(Self.message(of: error))"], answered: &answered)
            }
            return
        }
        defer { askEnded(askId) }
        do {
            await Task.yield() // the pending line reaches `pending` before it is flushed
            await flushAll()
            var input: [String: JSONValue] = ["askId": .string(askId), "ref": ref.json, "workspaceId": .string(workspaceId), "text": .string(q.text),
                                              "turns": .array(q.turns.map { t in var o: [String: JSONValue] = ["question": .string(t.question), "answer": .string(t.answer)]; if let a = t.agent { o["agent"] = .string(a) }; return .object(o) }),
                                              "choice": q.choice.map { ["model": .string($0.model), "effort": .string($0.effort)] } ?? .null,
                                              "agent": .string(q.agent), "stage": stageNow() ?? .null,
                                              "place": ["line": .number(Double(q.placeLine)), "text": .string(q.placeText)]]
            if let r = q.routed { input["routed"] = r }
            if let s = q.steer { input["steer"] = s }
            let asked = Task { try await api.askBart(projectId, .object(input)) }
            loadBartModels() // main has kept a pick by hand before this is read
            let out = try await asked.value
            let stopped = out["stopped"]?.bool == true, failed = out["failed"]?.bool == true
            let lines = out["lines"]?.array?.compactMap(\.string) ?? []
            // Discover settled what to research (2026-10-14): its box goes under the reply in the same change.
            let research = stopped ? nil : out["research"]?.string
            let box = research.map { (askId: WorkspaceText.newAskId(), line: Doc.researchLine($0)) }
            let placed: [String] = stopped ? (q.research ? ["bart> Stopped."] : []) : box.map { lines + [$0.line] + (q.refine ? [] : ["bart~> \($0.askId)"]) } ?? lines
            placeLines(key, ref, askId, placed, answered: &answered)
            let made = CreateWords.madeToOpen(lines: lines, stopped: stopped, failed: failed, askId: askId, askedIn: askedIn, here: live ? topicId : nil, active: live, opened: &madeOpened)
            if let box, !q.refine { boxOff(key, box.askId) }
            if let box, ownDirection, research != nil { nameDirection(research!); _ = box }
            if later && !ownTopic && !ownDirection { nameAs(stopped ? "" : WorkspaceText.answerText(lines)) }
            if ownTopic && !stopped && !failed { if let t = out["topic"]?.string { retitleTo(t) } else if q.name && !later { nameAs(q.text) } }
            // The Welcome walkthrough's last card answered: Discover starts on their next steps.
            if out["welcome"]?.string == "result" { handOff(key, askId) }
            // What Create made (2026-10-16, David): saved and opened without a click.
            if !stopped && answered != nil { madeLanded(Self.madeIn(lines, askId), open: made.map { MadeRef(askId: $0.askId, rel: $0.rel, name: $0.name) }) }
        } catch {
            placeLines(key, ref, askId, ["bart> **No answer.** \(Self.message(of: error))"], answered: &answered)
            if later && !ownTopic { nameAs("") }
        }
    }

    /// The files a run's answer stands for: its `bart> @[name](made:<askId>/<path>)` rows, this run's only.
    static func madeIn(_ lines: [String], _ askId: String) -> [MadeRef] {
        lines.compactMap { line -> MadeRef? in
            guard let m = DocRx.REPLY.match(line), let made = Inline.madeMentionOf(m[2]), made.askId == askId else { return nil }
            return MadeRef(askId: made.askId, rel: made.rel, name: made.name)
        }
    }

    /// The editor showing `key` asks @discover on its last brainstorm result once the result is in it (tries 30×100 ms).
    func handOff(_ key: String, _ askId: String) {
        retry(every: 0.1, tries: 30) { [weak self] in self?.editor(for: key)?.handleDiscoverLastResult(askId) ?? false }
    }
    /// A research box Discover settled on is asked by the editor showing `key` once its lines are in it (120×16 ms).
    func boxOff(_ key: String, _ askId: String) {
        retry(every: 0.016, tries: 120) { [weak self] in self?.editor(for: key)?.handleAskBoxed(askId) ?? false }
    }

    /// Bart, the router (2026-10-12): which agent an `@bart` line is for. The pending row says "Thinking · <level>"; a
    /// failure goes to the rule's agent, else the conversation's, else Chat, marked `by: 'error'` with why.
    public func routeLine(key: String, ref: PaneRef?, _ r: RouteAsk) async -> RoutePick {
        var run = AskRun(docKey: key, at: Date(), progress: AskProgress(agent: "router"))
        if let level = r.level { run.progress.name = level.name; run.progress.effort = level.effort }
        asks[r.askId] = run
        changed()
        let fallback: RoutePick = r.rule.map { RoutePick(agent: $0.agent, sure: 1, by: "rule", rule: $0.rule) } ?? RoutePick(agent: Route.fallbackAgent(r.inputs.current), sure: 0, by: "none")
        var input: [String: JSONValue] = [
            "text": .string(r.text), "section": .string(r.inputs.section), "workspaceName": .string(topic?.name ?? ""),
            "threads": .array(r.inputs.threads.map { ["agent": .string($0.agent), "question": .string($0.question), "up": .number(Double($0.up))] }),
            "specAbove": .bool(r.inputs.specAbove), "specTitle": .string(r.inputs.specTitle),
            "place": ["line": .number(Double(r.placeLine)), "text": .string(r.placeText)],
        ]
        if let rule = r.rule { input["rule"] = ["agent": .string(rule.agent), "rule": .string(rule.rule)] }
        if let c = r.inputs.current { input["current"] = .string(c) }
        if let ref { input["ref"] = ref.json }
        do {
            guard let out = try await api.routeLine(projectId, .object(input)), let agent = out["agent"]?.string else { return fallback }
            return RoutePick(agent: agent, sure: out["sure"]?.double ?? 0, by: out["by"]?.string ?? "model", rule: out["rule"]?.string, spec: out["spec"]?.bool ?? false, id: out["id"]?.string, error: out["error"]?.string)
        } catch {
            var pick = fallback
            pick.by = "error"; pick.error = Self.message(of: error)
            return pick
        }
    }
    public func routeGone(_ askId: String) { askEnded(askId) }

    /// A Build from the editor (2026-10-12): an @bart line handed to Build (its card in the pending line's place), or an
    /// answer's footer Build (its card on a line of its own after the thread: after `after`, found again by its words).
    public func buildFromEditor(key: String, ref: PaneRef, _ b: BuildAsk) async {
        guard topic != nil else { return }
        func put(_ lines: [String]) {
            guard let held = docs[key] else { return }
            if let askId = b.askId { if let next = Doc.placeAnswer(held, askId, lines) { changeDoc(key, ref, next) }; return }
            var ls = held.components(separatedBy: "\n")
            var at = -1
            if let after = b.after, after >= 0, after < ls.count, ls[after] == b.afterLine { at = after }
            if at < 0, let afterLine = b.afterLine {
                for (k, line) in ls.enumerated() where line == afterLine {
                    if at < 0 || abs(k - (b.after ?? 0)) < abs(at - (b.after ?? 0)) { at = k }
                }
            }
            if at < 0 { while let last = ls.last, last.trimmingCharacters(in: .whitespaces).isEmpty { ls.removeLast() }; at = ls.count - 1 }
            ls.insert(contentsOf: lines, at: at + 1)
            changeDoc(key, ref, ls.joined(separator: "\n"))
        }
        if let askId = b.askId {
            asks[askId] = AskRun(docKey: key, at: Date(), progress: AskProgress(agent: "router", activity: "Starting a Build"))
            changed()
        }
        defer { if let askId = b.askId { askEnded(askId) } }
        do {
            let task = try await buildFrom(ref: ref, text: b.text, routedFrom: b.routedFrom, place: (b.placeLine, b.placeText))
            put([Doc.buildLine(task["id"]?.string ?? "")])
        } catch {
            if b.askId != nil { put(["bart> **No Build.** \(Self.message(of: error))"]) } else { report(error) }
        }
    }

    /// A Build started from a line: everything open saved first; given `text` as a request typed on a line of the
    /// workspace; the router told where the line went.
    func buildFrom(ref: PaneRef, text: String, routedFrom: String?, place: (line: Int, text: String)?) async throws -> JSONValue {
        guard let topic else { throw WorkspaceError("Open a project first") }
        let workspaceId = ref.workspaceId ?? topic.id
        await Task.yield() // the pending line (or the edit) reaches `pending` first
        await flushAll()
        var input: [String: JSONValue] = ["workspaceId": .string(workspaceId), "text": .string(text), "fromLine": true]
        if let routedFrom { input["routedFrom"] = .string(routedFrom) }
        if let place { input["place"] = ["line": .number(Double(place.line)), "text": .string(place.text), "ref": ref.json] }
        let task = try await api.buildStart(projectId, .object(input))
        if let id = task["id"]?.string { builds[id] = task; changed() }
        if let routedFrom, let id = task["id"]?.string { await api.routeHanded(routedFrom, "build:\(id)") }
        return task
    }

    // MARK: asks from a highlight (MATH-27) or a box on a web page (MATH-70)

    /// @bart from a note on a pdf's highlight, or a box's card on a web page: asked of this workspace with the mark as its
    /// place, written into no document → the finished answer as the mark keeps it, or nil.
    public func askHighlight(markId: String, page: Int?, quote: String, note: String, question: String, turns: [JSONValue], rowId: String?, url: String?, paper: String?, pageText: String, source: String?) async -> JSONValue? {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let topic, !markId.isEmpty, !text.isEmpty, rowId != nil || url != nil else { return nil }
        let askId = WorkspaceText.highlightAskId()
        let web = source == "web"
        var entry: [String: JSONValue] = ["askId": .string(askId), "markId": .string(markId), "page": web ? .null : (page.map { .number(Double($0)) } ?? .null),
                                          "rowId": rowId.map { .string($0) } ?? .null, "url": rowId != nil ? .null : (url.map { .string($0) } ?? .null),
                                          "question": .string(text), "agent": "bart"]
        if web { entry["source"] = "web" }
        paperAsks[askId] = .object(entry)
        changed()
        var ref: [String: JSONValue] = ["kind": "mark", "id": .string(markId)]
        if let rowId { ref["rowId"] = .string(rowId) } else if let url { ref["url"] = .string(url) }
        if web { ref["source"] = "web" } else if let page { ref["page"] = .number(Double(page)) }
        let input: JSONValue = ["askId": .string(askId), "ref": .object(ref), "workspaceId": .string(topic.id), "text": .string(text), "turns": .array(turns),
                                "highlight": ["quote": .string(quote), "note": .string(note), "paper": paper.map { .string($0) } ?? .null, "pageText": .string(pageText)],
                                "stage": stageNow() ?? .null]
        do {
            let asked = Task { try await api.askBart(projectId, input) }
            loadBartModels()
            let out = try await asked.value
            if out["stopped"]?.bool == true { dropPaperAsk(askId); return nil }
            guard out["failed"]?.bool != true, let lines = out["lines"]?.array?.compactMap(\.string) else {
                failPaperAsk(askId, WorkspaceText.paperFailure(out["lines"]?.array?.compactMap(\.string)))
                return nil
            }
            dropPaperAsk(askId)
            if let e = out["entry"], !e.isNull { return e }
            let meta = out["meta"]
            return MarkAnswers.askEntry(id: askId, question: text, lines: lines, provider: meta?["provider"]?.string, name: meta?["level"]?["name"]?.string,
                                        effort: meta?["level"]?["effort"]?.string, ms: meta?["ms"]?.double, at: WorkspaceTime.iso())
        } catch {
            failPaperAsk(askId, Self.message(of: error))
            return nil
        }
    }

    public func dropPaperAsk(_ askId: String) { if paperAsks.removeValue(forKey: askId) != nil { changed() } }
    func failPaperAsk(_ askId: String, _ message: String) {
        guard var held = paperAsks[askId]?.object else { return }
        held["error"] = .string(message.isEmpty ? "The run failed." : message); held["activity"] = ""; held["lines"] = .array([])
        paperAsks[askId] = .object(held)
        changed()
    }
    /// engelbart:paper-ask-done: how a highlight's question ended, in every window.
    func onPaperAskDone(_ done: JSONValue) {
        guard let askId = done["askId"]?.string else { return }
        paperEnded.insert(askId)
        if done["failed"]?.bool == true { failPaperAsk(askId, WorkspaceText.paperFailure(done["lines"]?.array?.compactMap(\.string))) } else { dropPaperAsk(askId) }
    }
    /// pdf/canvas.js runningBack: the asks main still runs, back as boxes, less the ones that ended meanwhile.
    static func runningBack(_ current: [String: JSONValue], _ list: [JSONValue], ended: Set<String>) -> [String: JSONValue] {
        var out = current
        for item in list { if let id = item["askId"]?.string, !ended.contains(id), out[id] == nil { out[id] = item } }
        return out
    }
    public var pendingPaperAsks: [JSONValue] { paperAsks.keys.sorted().compactMap { paperAsks[$0] } }

    /// Continue in workspace on a highlight's answer: the passage, the question and the answer at the end of this
    /// workspace's document as a thread; a library paper comes into the workspace.
    public func continueAsk(lines: [String], paperRowId: String?) async {
        guard let topic else { return }
        let key = "ws:\(topic.id)", ref = PaneRef.workspace(topic.id)
        do {
            let held: String
            if let d = docs[key] { held = d } else { held = try await api.readDoc(projectId, .workspace(workspaceId: topic.id)) }
            let body = Rx(#"\n+$"#).replace(held, with: "")
            changeDoc(key, ref, "\(body.isEmpty ? "" : "\(body)\n\n")\(lines.joined(separator: "\n"))\n")
            showWs()
            if let rowId = paperRowId, !inRail(rowId) { try await linkIds([rowId]) }
        } catch { report(error) }
    }
}

public struct WorkspaceError: Error, LocalizedError, Equatable {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}
