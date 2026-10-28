import Foundation
import EngelbartCore

// session.cjs, the third part: MEMORY.md, starting a session (the librarian's opening and its grant, Import your
// context's direct run), the person's controls, placing rows on the project, quitting and resuming.

struct ToolJobSpec { var kind: String; var source: String; var apps: [String]; var label: String; var plan: String; var extra: (sites: [String], tool: ExtraTool?)?; var route: String?; var keyExtra: String }

extension Connect {
    // MARK: MEMORY.md

    func keepRecall(_ s: ConnectSession, _ app: String, _ text: String) {
        s.recalls[app] = text
        let dir = (s.dir as NSString).appendingPathComponent("memories")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        FileManager.default.createFile(atPath: (dir as NSString).appendingPathComponent("\(JS.replace(app, #"[^\w .-]+"#, "-")).md"), contents: Data((text + "\n").utf8), attributes: [.posixPermissions: 0o600])
        emit(s, soon: true)
    }

    /// MEMORY.md is written once the questions are over and every survey, recall and import has ended.
    func maybeMemory(_ s: ConnectSession) {
        if s.stopped || s.suspended || s.memoryQueued || !(s.done || s.finished) { return }
        if s.choices.direct != nil && !s.held.isEmpty { return }
        if s.jobs.contains(where: { Self.work.contains($0.kind) && !Self.ended.contains($0.status) }) { return }
        let worked = s.jobs.contains { Self.work.contains($0.kind) && $0.status == "done" } || !s.recalls.isEmpty
        if !worked { s.memory["status"] = "skipped"; return }
        s.memoryQueued = true
        s.memory["status"] = "writing"; s.memory["error"] = ""
        dispatch(s, kind: "memory", source: "memory", apps: [], label: "MEMORY.md")
    }

    /// What MEMORY.md's agent is told came in, never an email job (2026-10-11).
    func memoryJobs(_ s: ConnectSession) -> JSONValue {
        let appsOf = { (j: ConnectJob) in j.apps.isEmpty ? (s.choices.sources[j.source]?.apps ?? []) : j.apps }
        let email = { (j: ConnectJob) in j.source == "email" || appsOf(j).contains("Gmail") }
        let imports: [JSONValue] = s.jobs.filter { $0.kind == "import" && !email($0) }.map { j in
            ["label": .string(j.label), "status": .string(j.status), "notes": .number(Double(j.notes)), "items": .number(Double(j.items)), "said": .string(j.summary.isEmpty ? j.error : j.summary), "titles": .array(j.titles.prefix(40).map { .string($0) })]
        }
        let surveys: [JSONValue] = s.jobs.filter { $0.kind == "survey" && $0.status == "done" && !email($0) }.map { ["app": .string($0.apps.first ?? ""), "said": .string($0.summary)] }
        return ["imports": .array(imports), "surveys": .array(surveys)]
    }

    func memoryMessage(_ s: ConnectSession) -> String {
        let recalls = s.recalls.sorted { $0.key < $1.key }.map { "## \($0.key) (asked \(s.created.prefix(10)))\n\(Names.clipMiddle($0.value, 12000))" }
        let local = Memory.localMemories(homeDir: homeDir, env: env).map { "## \($0.app) (\($0.file))\n\($0.text)" }
        let existing = Memory.read(URL(fileURLWithPath: s.dataRoot))
        let custom = instructionsText(s.dataRoot)
        let mems = (recalls + local).joined(separator: "\n\n")
        return [existing.isEmpty ? "<existing_memory>none yet</existing_memory>" : "<existing_memory>\n\(existing)\n</existing_memory>",
                "<assistant_memories>\n\(mems.isEmpty ? "none" : mems)\n</assistant_memories>",
                "<conversation>\n\(Names.clipMiddle(conversationText(s), 20000))\n</conversation>",
                "<imports>\n\(memoryJobs(s).text(pretty: true))\n</imports>",
                custom.isEmpty ? "" : "<custom_instructions>\n\(custom)\n</custom_instructions>",
                s.choices.custom.isEmpty ? "" : "<import_instructions>\n\(s.choices.custom)\n</import_instructions>",
                "<folders note=\"Where what came in is, as Markdown files (one folder each), to Read when a title is not enough.\">\([(s.dataRoot as NSString).appendingPathComponent("assets/md"), (s.dir as NSString).appendingPathComponent("notes"), s.projectDir].compactMap { $0 }.joined(separator: ", "))</folders>",
                "Today is \(s.created.prefix(10)). Write MEMORY.md now."].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    static func stripFence(_ text: String) -> String { JS.replace(JS.replace(text.trimmingCharacters(in: .whitespacesAndNewlines), #"^```(?:markdown|md)?\s*"#, "", options: .caseInsensitive), #"\s*```$"#, "") }

    func drafted(_ s: ConnectSession, _ text: String) throws {
        let draft = Self.stripFence(text)
        if draft.count < 40 { throw ConnectError("failed", "The memory agent wrote nothing to keep") }
        s.memoryDraft = draft
        s.memory["status"] = "cleaning"
        // "one background claude sonnet agent": Claude Code's Sonnet when it can run, else the session's own pinned model.
        s.redactChoice = readyNow().contains("anthropic") ? choiceFor("anthropic") : s.choice
        dispatch(s, kind: "redact", source: "memory", apps: [], label: "MEMORY.md, secrets out")
    }

    func finishMemory(_ s: ConnectSession, _ text: String) throws {
        let draft = s.memoryDraft ?? ""
        var cleaned = Self.stripFence(text)
        if Double(cleaned.count) < Double(draft.count) * 0.5 { logAction(s, nil, "The secrets check returned too little; kept the draft with known secrets masked"); cleaned = draft }
        let scrubbed = Memory.scrubSecrets(cleaned)
        let saved = try Memory.save(URL(fileURLWithPath: s.dataRoot), scrubbed.text)
        s.memoryDraft = nil
        s.memory = ["status": "saved", "path": .string(saved.path.path), "previous": saved.previous.map { .string($0.path) } ?? .null, "removed": .number(Double(scrubbed.removed)), "error": "", "at": .string(now())]
        logAction(s, nil, "Saved MEMORY.md\(scrubbed.removed > 0 ? " (\(scrubbed.removed) more secret\(scrubbed.removed == 1 ? "" : "s") masked)" : "")")
    }

    // MARK: start

    func scan(_ s: ConnectSession, _ choices: JSONValue) async -> JSONValue {
        await Scan.scanFor(choices, homeDir: homeDir, env: env, picked: s.picked.folders, zotero: deps.zotero.scan, github: deps.github.scan,
                           appleNotes: s.choices.permissions.notes ? deps.appleNotes : nil, access: accessOf(s))
    }

    func setFound(_ s: ConnectSession, _ fresh: JSONValue) {
        s.found = [:]
        for (source, apps) in fresh.object ?? [:] { s.found[source] = apps.object ?? [:] }
    }

    func rescan(_ s: ConnectSession, _ sourceIds: [String]) async {
        var only = s.choices.scanJSON.object ?? [:]
        only["sources"] = .object((s.choices.json["sources"]?.object ?? [:]).filter { sourceIds.contains($0.key) })
        let fresh = await scan(s, .object(only))
        for (source, apps) in fresh.object ?? [:] {
            var merged = s.found[source] ?? [:]
            for (app, value) in apps.object ?? [:] {
                let before = merged[app]
                // What a survey found is kept; where a folder search looked is kept while the folder is still missing.
                if let before, JS.truthy(before["survey"]), JS.truthy(value["reach"]) { continue }
                if let before, JS.truthy(before["searched"]), value["needs"]?.string == "folder" { var v = value.object ?? [:]; v["searched"] = before["searched"]; merged[app] = .object(v); continue }
                merged[app] = value
            }
            s.found[source] = merged
            s.newFound = s.newFound ?? [:]; s.newFound![source] = merged
        }
        s.dirs = dirsOf(s)
        lookForFolders(s)
    }

    /// The choose screen sent: the session, the scan, the first surveys, and the librarian's first turn. → snapshot
    public func start(_ given: JSONValue) async throws -> JSONValue {
        let dataRoot = await deps.store.dataRoot()
        let input = SessionText.directInput(given, homeDir: homeDir)
        var choices = SessionText.cleanChoices(input, homeDir: homeDir)
        // Import manually with fine-grained permissions (From Amitav, 2026-10-15): a librarian session that asks first.
        let asked = input["librarian"] == .bool(true) ? choices.direct : nil
        if let asked {
            choices.custom = String([choices.custom, SessionText.librarianNotes(asked)].filter { !$0.isEmpty }.joined(separator: "\n\n").prefix(4000))
            choices.sources["sites"]?.on = asked.apps.contains(ImportFlow.sites)
            choices.extras = asked.additional
            choices.direct = nil
        }
        if !choices.sources.values.contains(where: \.on) && choices.extras.isEmpty { throw ConnectError("failed", "Pick at least one source.") }
        let usable = readyNow()
        let requested = input["provider"]?.string
        let waitFor = usable.isEmpty && choices.direct != nil ? (requested.flatMap { ConnectModels.providers.contains($0) ? $0 : nil } ?? "anthropic") : nil
        if usable.isEmpty && waitFor == nil { throw ConnectError("failed", "Sign in to Claude Code or Codex first: the agents run on one of them.") }
        let provider = waitFor ?? (requested.flatMap { usable.contains($0) ? $0 : nil } ?? usable[0])
        choices.browserAgents = nil
        if choices.direct != nil, let ba = deps.browserAgents {
            let status = ba.status(provider: provider, browserId: input["browser"]?.string)
            if status.use, let b = status.browser { choices.browserAgents = BrowserAgentsChoice(browserId: b.id, browserName: b.name, enable: !status.allowedByCli) }
        }
        let id = IDs.new()
        var projectId: String?, projectDir: String?
        if let pid = input["projectId"]?.string, JS.test(pid, Self.idRE, options: .caseInsensitive), let dir = await deps.store.projectDir(pid) { projectId = pid; projectDir = dir }
        var workspaceId: String?
        if let projectId, let wid = input["workspaceId"]?.string, JS.test(wid, Self.idRE, options: .caseInsensitive), await deps.store.workspaceExists(projectId: projectId, workspaceId: wid) { workspaceId = wid }
        let s = ConnectSession(id: id, mode: projectId != nil ? "existing" : "onboarding", dataRoot: dataRoot, created: now(), choices: choices, choice: choiceFor(provider))
        s.projectId = projectId; s.projectDir = projectDir; s.workspaceId = workspaceId
        s.manual = asked != nil
        if let scoped = choices.direct ?? asked { for (app, scope) in scoped.scopes where Self.findApps.contains(app) && app != ConnectSources.localPDFs { if let p = scope.folders.first?.path { s.picked.folders[app] = p } } }
        if let waitFor { s.blocked = (waitFor, "\(ConnectModels.providerNames[waitFor]!) is not connected", now()) }
        sessions[id] = s
        s.dirs = dirsOf(s)
        logAction(s, nil, "Started with \(ConnectModels.providerNames[s.choice.provider]!) (\(s.choice.modelName) · \(s.choice.effort))")
        traced(kind: "start", sessionId: id, text: "Connect session started\(choices.direct.map { " (Import your context, \($0.mode == "manual" ? "sources chosen by the person" : "tools found by agents"))" } ?? "") on \(ConnectModels.providerNames[s.choice.provider]!) (\(s.choice.modelName) · \(s.choice.effort))", detail: ["choices": choices.json])
        emit(s)
        Task { await opening(s) }
        return snapshot(s)
    }

    func opening(_ s: ConnectSession) async {
        if s.choices.direct != nil { await directOpening(s); return }
        var opener = s.chat.first { JS.truthy($0.value["opener"]) }
        if opener == nil {
            let o = ChatEntry(["role": "agent", "text": "Looking at what you picked…", "ask": .null, "authorize": .null, "opener": true, "at": .string(now())])
            s.chat.append(o); opener = o; emit(s)
        }
        if deps.allowedAll { askedApps(s).forEach { s.allowed.insert($0) } }
        if askGrant(s) != nil { emit(s) }
        setFound(s, await scan(s, s.choices.scanJSON))
        if s.stopped || s.suspended { return }
        opener!.value["text"] = .string(foundSentence(s))
        s.dirs = dirsOf(s)
        markAsking(s)
        emit(s)
        await granted(s)
        if s.stopped || s.suspended { return }
        let lines = await beginApps(s, askedApps(s).filter { s.allowed.contains($0) })
        if s.stopped || s.suspended { return }
        lookForFolders(s)
        if !lines.isEmpty { opener!.value["text"] = .string("\(JS.string(opener!.value["text"]))\n\n\(lines)") }
        emit(s)
        await interviewTurn(s, "Start.")
    }

    func afterGrant(_ s: ConnectSession) async {
        await granted(s)
        if s.stopped || s.suspended { return }
        _ = await beginApps(s, askedApps(s).filter { s.allowed.contains($0) })
        if s.stopped || s.suspended || s.finished { return }
        lookForFolders(s)
        emit(s)
        if lastSaid(s) == nil && !s.thinking { await interviewTurn(s, "Start.") }
    }

    func askedApps(_ s: ConnectSession) -> [String] {
        var out: [String] = []
        for source in ConnectSources.sourceIds { guard let c = s.choices.sources[source], c.on else { continue }
            for app in c.apps where Self.asksFirst(app) && !s.skipped.contains(app) && !out.contains(app) { out.append(app) } }
        return out
    }

    func openGrant(_ s: ConnectSession) -> ChatEntry? { s.chat.first { JS.truthy($0.value["grant"]) && ($0.value["grant"]?["answered"]?.isNull ?? true) } }

    /// The librarian's run asks once, in one message, the first one in the chat (2026-10-16): "Allow Engelbart to access…".
    func askGrant(_ s: ConnectSession) -> ChatEntry? {
        if let open = openGrant(s) { return open }
        var rows: [JSONValue] = askedApps(s).filter { !s.allowed.contains($0) }.map { ["id": .string($0), "name": .string(ConnectSources.shownName($0))] }
        rows += s.choices.extras.filter { !s.allowed.contains($0.name) && !s.skipped.contains($0.name) }.map { t in
            var o: [String: JSONValue] = ["id": .string(t.name), "name": .string(t.name), "tool": true]
            if !t.website.isEmpty { o["website"] = .string(t.website) }
            return .object(o)
        }
        if rows.isEmpty { return nil }
        let entry = ChatEntry(["role": "agent", "text": "", "grant": ["rows": .array(rows), "answered": .null], "ask": .null, "authorize": .null, "at": .string(now())])
        s.chat.append(entry)
        for row in rows where row["tool"] == nil { s.holdSet(JS.string(row["id"]), source: ConnectSources.sourceOfApp(JS.string(row["id"])) ?? "other", consent: true) }
        logAction(s, nil, "Asking you: Allow Engelbart to access \(SessionText.listed(rows.map { JS.string($0["name"]) }))?")
        return entry
    }

    func markAsking(_ s: ConnectSession) {
        guard let entry = openGrant(s) else { return }
        for row in entry.value["grant"]?["rows"]?.array ?? [] where row["tool"] == nil {
            let id = JS.string(row["id"])
            if let source = ConnectSources.sourceOfApp(id) {
                s.put(source, id, ["reach": .string(ConnectSources.apps[id]?.reach.rawValue ?? "web"), "consent": "asking: Engelbart asks the person to allow it. Nothing of it has been looked at. Do not ask about it, offer it or dispatch it."])
            }
        }
    }

    func granted(_ s: ConnectSession) async {
        if openGrant(s) == nil || s.stopped || s.suspended { return }
        await withCheckedContinuation { s.grantWaiters.append($0) }
    }
    func releaseGrant(_ s: ConnectSession) { let w = s.grantWaiters; s.grantWaiters = []; w.forEach { $0.resume() } }

    /// "Grant access" on the grant: { apps: [the ids ticked] }, at least one. → snapshot
    public func grant(_ id: String, _ input: JSONValue) throws -> JSONValue {
        let s = try get(id)
        guard let entry = openGrant(s) else { return snapshot(s) }
        let ids = Set((input["apps"]?.array ?? []).compactMap(\.string))
        let allowed = (entry.value["grant"]?["rows"]?.array ?? []).map { JS.string($0["id"]) }.filter { ids.contains($0) }
        if allowed.isEmpty { throw ConnectError("failed", "Pick at least one app") }
        answerGrant(s, entry, allowed, why: "you didn’t allow Engelbart to access it")
        return snapshot(s)
    }

    func answerGrant(_ s: ConnectSession, _ entry: ChatEntry, _ ids: [String], why: String) {
        let rows = entry.value["grant"]?["rows"]?.array ?? []
        let allowedNames = rows.filter { ids.contains(JS.string($0["id"])) }.map { JS.string($0["name"]) }
        let skippedNames = rows.filter { !ids.contains(JS.string($0["id"])) }.map { JS.string($0["name"]) }
        var grant = entry.value["grant"]?.object ?? [:]
        grant["answered"] = ["allowed": .array(allowedNames.map { .string($0) }), "skipped": .array(skippedNames.map { .string($0) }), "at": .string(now())]
        entry.value["grant"] = .object(grant)
        for row in rows {
            let id = JS.string(row["id"])
            if ids.contains(id) { allowOne(s, row); continue }
            s.leave(id, why)
            if row["tool"] != nil { s.skipped.insert(id) } else { skipApp(s, id); releaseHeld(s, id, "skip") }
        }
        logAction(s, nil, !allowedNames.isEmpty ? "Allowed Engelbart to access \(SessionText.listed(allowedNames))" : "Left out \(SessionText.listed(skippedNames))", who: "You")
        save(s); emit(s); releaseGrant(s)
    }

    func allowOne(_ s: ConnectSession, _ row: JSONValue) {
        let id = JS.string(row["id"])
        s.allowed.insert(id)
        if row["tool"] != nil {
            if let tool = s.choices.extras.first(where: { $0.name == id }) { Task { await extraImport(s, tool) } }
            return
        }
        s.unhold(id)
        if let source = ConnectSources.sourceOfApp(id) { var e = s.found[source]?[id]?.object ?? [:]; e["consent"] = nil; s.put(source, id, .object(e)) }
    }

    func extraImport(_ s: ConnectSession, _ tool: ExtraTool) async {
        let job = await toolJob(s, tool) { how, host in
            "This is a tool they use that Engelbart has no import of its own for: \(SessionText.toolSaid(tool)). \(how), and bring in its pages, documents or items about the project in <project> as notes (add_note).\(host.isEmpty ? " It has no website given: look for it in their browser history first." : "")"
        }
        dispatch(s, kind: job.kind, source: job.source, apps: job.apps, label: job.label, plan: job.plan, extra: job.extra, route: job.route, keyExtra: job.keyExtra)
    }

    /// One of the Other tools' imports: its sign-in copied from the chosen profile; their own browser only when nothing could be.
    func toolJob(_ s: ConnectSession, _ tool: ExtraTool, plan: (String, String) -> String) async -> ToolJobSpec {
        let sites = Self.toolSites(tool)
        let out = !sites.isEmpty && s.choices.keychain ? await copyTool(tool) : nil
        let copied = (out?.copied ?? 0) > 0 || out?.signedIn == true
        if copied { logAction(s, nil, "Copied your \(tool.name) sign-in") }
        let ba = copied ? nil : s.choices.browserAgents
        let how = ba.map { "Open it in a tab of your own in their \($0.browserName), where they are signed in" } ?? "Open it through their sign-in in Engelbart's browser"
        var t = tool; t.sites = sites
        return ToolJobSpec(kind: "import", source: "sites", apps: [], label: String("Other tools: \(tool.name)".prefix(120)), plan: plan(how, sites.first ?? ""),
                           extra: (sites, t), route: ba != nil ? "browser" : nil, keyExtra: tool.name)
    }

    /// The apps a run may reach now, started → the opener's sign-in lines.
    func beginApps(_ s: ConnectSession, _ apps: [String]) async -> String {
        if apps.isEmpty { return "" }
        await checkConnectors(apps)
        let checked = await signInsFirst(s, only: apps)
        if s.stopped || s.suspended { return "" }
        startWork(s, held: Set(checked.signedOut + checked.refused.map(\.0) + checked.checking.map(\.0)), only: apps)
        for (app, answer) in checked.checking where s.held[app] != nil { lateSignIn(s, app, answer) }
        for app in checked.signedOut where s.held[app] != nil { recoverHeld(s, app) }
        for (app, name) in checked.refused {
            skipApp(s, app); releaseHeld(s, app, "skip")
            logAction(s, nil, "Skipped \(ConnectSources.shownName(app)): macOS didn't allow \(name.isEmpty ? "your browser" : name)'s sign-ins")
        }
        emit(s)
        return SessionText.signInLines(signedIn: checked.signedIn, refused: checked.refused)
    }

    // MARK: Import your context (direct)

    func directOpening(_ s: ConnectSession) async {
        guard let d = s.choices.direct else { return }
        let titles = d.projects.map(\.title)
        var opener = s.chat.first { JS.truthy($0.value["opener"]) }
        if opener == nil {
            let o = ChatEntry(["role": "agent", "text": .string(titles.isEmpty ? "Bringing in what you picked…" : "Bringing in what pertains to \(SessionText.listed(titles))…"), "ask": .null, "authorize": .null, "opener": true, "at": .string(now())])
            s.chat.append(o); opener = o; emit(s)
        }
        s.thinking = true
        s.activity = "Looking at what you picked…"
        setFound(s, await scan(s, s.choices.scanJSON))
        if s.stopped || s.suspended { return }
        s.dirs = dirsOf(s)
        s.connected = []
        await checkConnectors(d.apps)
        for app in d.apps where isConnectorApp(app) {
            guard let c = deps.connectors else { break }
            if await c.reaches(app, provider: s.choice.provider) { s.connected.insert(app) }
        }
        if !s.connected.isEmpty { logAction(s, nil, "Using your \(SessionText.listed(s.connected.sorted().map(ConnectSources.shownName))) connection\(s.connected.count == 1 ? "" : "s")") }
        var checked = await signInsFirst(s)
        if s.stopped || s.suspended { return }
        if !s.choices.keychain, let ba = s.choices.browserAgents { checked.elsewhere += checked.signedOut.map { ($0, ba.browserName) }; checked.signedOut = [] }
        if s.choices.browserAgents == nil && deps.signInWindow != nil { checked.signedOut += checked.elsewhere.map(\.0); checked.elsewhere = [] }
        let held = Set(checked.signedOut + checked.checking.map(\.0))
        for (app, name) in checked.refused {
            s.leave(app, "macOS didn't allow \(name.isEmpty ? "your browser" : name)'s sign-ins")
            skipApp(s, app)
            logAction(s, nil, "Skipped \(ConnectSources.shownName(app)): macOS didn't allow \(name.isEmpty ? "your browser" : name)'s sign-ins")
        }
        for (app, name) in checked.elsewhere { readElsewhere(s, app, name) }
        if !s.fallback.isEmpty, let ba = s.choices.browserAgents { logAction(s, nil, "\(SessionText.listed(s.fallback.sorted().map(ConnectSources.shownName))) in \(ba.browserName), in the background") }
        let webChecked = { (app: String) in checked.signedIn.contains { $0.0 == app } || checked.refused.contains { $0.0 == app } || checked.elsewhere.contains { $0.0 == app } || checked.signedOut.contains(app) || checked.checking.contains { $0.0 == app } }
        var ownHeld: [String: String] = [:]
        var viaSite = Set<String>()
        for app in d.apps where !s.skipped.contains(app) && !held.contains(app) {
            if isConnectorApp(app) && !s.connected.contains(app) && connectorFallback(s, app) { viaSite.insert(app); continue }
            if Self.signinApps.contains(app) && !ownStatus(app).connected && (app == "Zotero" ? deps.zotero.status() != nil : deps.github.status() != nil) { ownHeld[app] = "signin" }
            else if isConnectorApp(app) && deps.connectors != nil && !s.connected.contains(app) && !webChecked(app) { ownHeld[app] = "connector" }
        }
        for app in d.apps where !s.skipped.contains(app) {
            if held.contains(app) { s.holdSet(app, source: ImportFlow.groupOfApp(app) ?? "other"); if checked.signedOut.contains(app) { recoverHeld(s, app) }; continue }
            if let kind = ownHeld[app] { signInCard(s, app, kind: kind); continue }
            if viaSite.contains(app) { continue }
            directImport(s, app)
        }
        for (app, answer) in checked.checking { lateSignIn(s, app, answer) }
        for tool in d.additional {
            let base = ImportFlow.importPlan(app: ImportFlow.sites, mode: d.mode, projects: d.flowProjects, roles: d.roles, work: d.work, period: ConnectSources.periodName(s.choices.days))
            let job = await toolJob(s, tool) { how, host in
                "\(base)\n\nThis is a tool they use that Engelbart has no import of its own for: \(SessionText.toolSaid(tool)). \(how), and bring in its pages, documents or items about these projects as notes (add_note) or saved pages.\(host.isEmpty ? " It has no website given: look for it in their browser history first." : "")"
            }
            dispatch(s, kind: job.kind, source: job.source, apps: job.apps, label: job.label, plan: job.plan, extra: job.extra, route: job.route, keyExtra: job.keyExtra)
        }
        if s.choices.permissions.recall && s.choices.permissions.browser {
            let chats = s.choices.sources["chats"]
            for app in ConnectSources.recallApps(chats?.on == true ? chats!.apps : []) where !s.skipped.contains(app) {
                if s.fallback.contains(app) && !checked.signedIn.contains(where: { $0.0 == app }) { continue }
                if var h = s.held[app] { h.recall = true; s.held[app] = h }
                else { dispatch(s, kind: "recall", source: "chats", apps: [app], label: "Asking \(ConnectSources.shownName(app)) what it remembers") }
            }
        }
        let lines = [SessionText.signInLines(signedIn: checked.signedIn, refused: checked.refused), s.held.isEmpty ? "" : "Waiting for you to sign in to \(SessionText.listed(s.heldOrder.map(ConnectSources.shownName)))."].filter { !$0.isEmpty }.joined(separator: "\n")
        opener!.value["text"] = .string("\(JS.replace(foundSentence(s), " Starting with .*$", ""))\(lines.isEmpty ? "" : "\n\n\(lines)")")
        s.thinking = false; s.activity = ""; s.done = true; s.finished = true
        emit(s)
        maybeMemory(s)
    }

    @discardableResult
    func directImport(_ s: ConnectSession, _ app: String) -> ConnectJob? {
        guard let d = s.choices.direct else { return nil }
        let route = s.choices.browserAgents != nil && s.fallback.contains(app) ? "browser" : nil
        let plan = ImportFlow.importPlan(app: app, mode: d.mode, projects: d.flowProjects, roles: d.roles, work: d.work, scope: d.scopes[app], period: ConnectSources.periodName(s.choices.days), browser: route != nil ? s.choices.browserAgents!.browserName : "")
        let whereText = { (folders: [String]) in folders.isEmpty ? "" : "\n\nThe folders: \(folders.map { Readers.shownPath(self.homeDir, $0) }.joined(separator: ", "))." }
        if app == ImportFlow.sites { return dispatch(s, kind: "import", source: "sites", label: "Pages from your browser history", plan: plan) }
        if app == ImportFlow.localFolders { return dispatch(s, kind: "import", source: "code", label: "Folders on this Mac", plan: plan + whereText(s.choices.sources["code"]?.folders ?? [])) }
        if app == "GitHub" { return dispatch(s, kind: "import", source: "code", apps: ["GitHub"], label: "GitHub", plan: plan) }
        guard let source = ImportFlow.groupOfApp(app), let group = ConnectSources.sourceOf(source) else { return nil }
        return dispatch(s, kind: "import", source: source, apps: [app], label: "\(group.label): \(ConnectSources.shownName(app))",
                        plan: app == ConnectSources.localPDFs ? plan + whereText(s.choices.sources["papers"]?.folders ?? []) : plan, route: route)
    }

    /// What the scan found, in one plain sentence.
    func foundSentence(_ s: ConnectSession) -> String {
        let plural = { (n: Int, one: String, many: String?) in "\(n) \(n == 1 ? one : many ?? one + "s")" }
        var parts: [String] = []
        var firstSource: [String] = []
        for source in ConnectSources.sourceIds {
            guard let apps = s.found[source] else { continue }
            let before = parts.count
            for (app, value) in apps.sorted(by: { $0.key < $1.key }) where value.object != nil {
                let shown = ConnectSources.shownName(app)
                if let vaults = value["vaults"]?.array, !vaults.isEmpty { parts.append(plural(vaults.count, "\(shown) vault", nil)) }
                else if let folders = value["folders"]?.array, !folders.isEmpty, let pdfs = value["pdfs"]?.double {
                    let whereList = folders.prefix(2).compactMap { $0["folder"]?.string }.filter { !$0.isEmpty }
                    parts.append("\(plural(Int(pdfs), "PDF", nil))\(s.choices.days.map { " from \(ConnectSources.periodName($0))" } ?? "")\(whereList.isEmpty ? "" : " in \(whereList.joined(separator: " and "))")")
                } else if let chats = value["chats"]?.double, chats > 0 { parts.append("your \(shown) chats") }
                else if JS.truthy(value["signedIn"]), let items = value["items"]?.double { parts.append(plural(Int(items), "\(shown) item", nil)) }
                else if let repos = value["repos"]?.array, !repos.isEmpty { parts.append(plural(repos.count, "\(shown) repository", "\(shown) repositories")) }
            }
            if parts.count > before { firstSource.append(source) }
        }
        let ticked = ConnectSources.sourceIds.filter { s.choices.sources[$0]?.on == true }
        let startWith = ticked.first { firstSource.contains($0) } ?? ticked.first
        let label = startWith.flatMap { ConnectSources.sourceOf($0)?.label.lowercased() } ?? ""
        let list = parts.count > 1 ? "\(parts.dropLast().joined(separator: ", ")) and \(parts.last!)" : parts.first
        let found = list.map { "Found \($0)." } ?? "Had a look at what you picked."
        return label.isEmpty ? found : "\(found) Starting with your \(label)."
    }

    // MARK: the person's answers

    func busy(_ s: ConnectSession) throws { if s.thinking { throw ConnectError("failed", "Wait for the librarian to answer") } }

    /// The person answered: { text } | { picked: [labels], text? } | { skipped: true }, and maybe { provider }.
    public func answer(_ id: String, _ value: JSONValue) throws -> JSONValue {
        let s = try get(id)
        try busy(s)
        let picked = (value["picked"]?.array ?? []).compactMap(\.string).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.prefix(12)
        let text = String((value["text"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(4000))
        var clean: [String: JSONValue] = value["skipped"] == .bool(true) ? ["skipped": true] : !picked.isEmpty ? ["picked": .array(picked.map { .string($0) }), "text": .string(text)] : ["text": .string(text)]
        if clean["skipped"] == nil && clean["picked"] == nil && text.isEmpty { throw ConnectError("failed", "Say something first") }
        if let p = value["provider"]?.string { try setProvider(s, p) }
        if clean["skipped"] != nil { clean["left"] = .string(skipAsked(s)) }
        if !picked.isEmpty { approvePicked(s, Array(picked)) }
        s.chat.append(ChatEntry(["role": "user", "text": .string(SessionText.shownOf(.object(clean))), "at": .string(now())]))
        let message = SessionText.messageOf(.object(clean))
        turnSoon(s, message)
        return snapshot(s)
    }

    /// What the person ticked is what may be read (From Amitav, 2026-10-15), by the ids its survey reported.
    func approvePicked(_ s: ConnectSession, _ labels: [String]) {
        guard let ask = lastSaid(s)?.value["ask"], let options = ask["options"]?.array, let source = ask["source"]?.string, let group = ConnectSources.sourceOf(source) else { return }
        let named = ask["apps"]?.array?.compactMap(\.string) ?? []
        let apps = (named.isEmpty ? group.apps : named).filter { Tools.approvalApps.contains($0) }
        let same = { (a: String, b: String) in a.trimmingCharacters(in: .whitespaces).lowercased() == b.trimmingCharacters(in: .whitespaces).lowercased() }
        for app in apps {
            let items = s.found[source]?[app]?["survey"]?["items"]?.array ?? []
            let known = Set(items.compactMap { $0["id"]?.string }.filter { !$0.isEmpty })
            for option in options where labels.contains(JS.string(option["label"])) {
                let given = option["ids"]?.array?.compactMap(\.string) ?? []
                let ids = given.isEmpty ? items.filter { same(JS.string($0["label"]), JS.string(option["label"])) }.compactMap { $0["id"]?.string } : given
                for id in ids where known.contains(id) { s.approved[app, default: []].insert(id) }
            }
        }
        if !apps.isEmpty { save(s) }
    }

    func setProvider(_ s: ConnectSession, _ provider: String) throws {
        guard ConnectModels.providers.contains(provider), provider != s.choice.provider else { return }
        let name = ConnectModels.providerNames[provider]!
        if !readyNow().contains(provider) { throw ConnectError("failed", "\(name) is not signed in") }
        s.choice = choiceFor(provider)
        s.interviewSession = nil
        logAction(s, nil, "Switched to \(name) (\(s.choice.modelName) · \(s.choice.effort))", who: "You")
    }

    public func setProvider(_ id: String, _ provider: String) throws -> JSONValue { let s = try get(id); try setProvider(s, provider); emit(s); return snapshot(s) }

    /// A button in the chat was used (signin / connector / permission / folder), then the librarian goes on.
    public func authorize(_ id: String, _ input: JSONValue) async throws -> JSONValue {
        let s = try get(id)
        try busy(s)
        guard let app = input["app"]?.string, ConnectSources.apps[app] != nil || app == "GitHub" else { throw ConnectError("failed", "Unknown app") }
        let given = input["kind"]?.string ?? ""
        let kind = SessionText.authorizeKinds.contains(given) ? given : given == "file" ? "folder" : ""
        if kind.isEmpty { throw ConnectError("failed", "Unknown kind") }
        let source = ConnectSources.sourceOfApp(app)
        let shown = ConnectSources.shownName(app)
        var clean: JSONValue
        if kind == "connector" {
            guard let connectors = deps.connectors else { throw ConnectError("failed", "\(shown) cannot be signed in to here") }
            s.activity = "Waiting for you to sign in to \(shown) in your browser"; s.thinking = true; emit(s)
            do { _ = try await connectors.signIn(app) } catch { s.thinking = false; s.activity = ""; emit(s); throw error }
            s.thinking = false; s.activity = ""
            clean = ["authorized": ["app": .string(app), "kind": .string(kind)]]
            if let source { s.put(source, app, ["reach": "connector", "survey": "running"]); dispatch(s, kind: "survey", source: source, apps: [app], label: "Looking through \(shown)") }
        } else if kind == "permission" {
            guard let notes = deps.appleNotes else { throw ConnectError("failed", "\(shown) cannot be read here") }
            let out = await notes.permission()
            if !out.allowed { throw ConnectError("failed", out.error.isEmpty ? "macOS did not allow it" : out.error) }
            s.choices.permissions.notes = true
            clean = ["authorized": ["app": .string(app), "kind": .string(kind)]]
        } else if kind == "signin" {
            clean = ["authorized": ["app": .string(app), "kind": .string(kind)]]
        } else {
            guard let file = Readers.expandPath(homeDir, input["path"]?.string), file.hasPrefix(homeDir + "/"), Readers.exists(file) else { throw ConnectError("failed", "Choose something inside your home folder") }
            s.picked.folders[app] = file
            let dir = Readers.isDir(file) ? file : (file as NSString).deletingLastPathComponent
            var picked = s.choices.picked.filter { $0 != dir }; picked.append(dir)
            s.choices.picked = Array(picked.suffix(40))
            clean = ["chose": ["app": .string(app), "kind": "folder", "shown": .string(Readers.shownPath(homeDir, file))]]
        }
        s.chat.append(ChatEntry(["role": "user", "text": .string(SessionText.shownOf(clean)), "at": .string(now())]))
        logAction(s, nil, SessionText.shownOf(clean), who: "You")
        s.thinking = true
        emit(s)
        if app == "Zotero" && kind == "signin" {
            s.activity = "Waiting for your Zotero library to sync"; emit(s)
            for _ in 0..<90 where !s.stopped {
                if let root = deps.zotero.root(), Readers.exists((root as NSString).appendingPathComponent("items.json")) { break }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
            s.activity = ""
        }
        if kind != "connector" { await rescan(s, source.map { [$0] } ?? []) }
        s.thinking = false
        let message = SessionText.messageOf(clean)
        turnSoon(s, message)
        return snapshot(s)
    }

    /// Import: every source picked and not yet handed over goes now. → snapshot
    public func importNow(_ id: String) throws -> JSONValue {
        let s = try get(id)
        s.finished = true
        s.interviewController?.abort()
        if let open = openGrant(s) { answerGrant(s, open, [], why: "you pressed Import before allowing it") }
        for source in ConnectSources.sourceIds {
            guard let choice = s.choices.sources[source], choice.on, !s.skippedSources.contains(source) else { continue }
            let sent = s.jobs.filter { $0.kind == "import" && $0.source == source }
            if sent.contains(where: { $0.apps.isEmpty }) { continue }
            let covered = Set(sent.flatMap(\.apps))
            let reachable = { (app: String) -> Bool in
                let found = s.found[source]?[app]
                switch ConnectSources.apps[app]?.reach {
                case .web: return s.choices.permissions.browser
                case .connector: return (try? self.deps.connectors?.status(app).connected) == true
                case .automation: return s.choices.permissions.notes
                default: return !(JS.truthy(found?["needs"]) || JS.truthy(found?["looking"]))
                }
            }
            let apps = choice.apps.filter { !covered.contains($0) && !s.skipped.contains($0) && reachable($0) }
            if !sent.isEmpty && apps.isEmpty { continue }
            if !choice.apps.isEmpty && apps.isEmpty && choice.folders.isEmpty && choice.repos.isEmpty { continue }
            let label = ConnectSources.sourceOf(source)!.label
            let whereText = [apps.isEmpty ? "" : "from \(apps.joined(separator: ", "))", choice.folders.isEmpty ? "" : "folders \(choice.folders.joined(separator: ", "))",
                             choice.repos.isEmpty ? "" : "repositories \(choice.repos.joined(separator: ", ")) (already in the library)"].filter { !$0.isEmpty }.joined(separator: "; ")
            dispatch(s, kind: "import", source: source, apps: apps, label: apps.isEmpty ? label : "\(label): \(apps.map(ConnectSources.shownName).joined(separator: ", "))",
                     plan: "Bring in \(label.lowercased()) \(whereText) as the person picked and said in the chat. They pressed Import before this source was talked through, so use sensible defaults: leave out daily notes, personal folders and journals; tools used every day (mail, calendar, social media); runs a program started; anything older than about six months when there is a lot.")
        }
        s.chat.append(ChatEntry(["role": "user", "text": "Import now", "at": .string(now())]))
        s.done = true
        s.waitingForSurvey = false
        emit(s)
        maybeMemory(s)
        return snapshot(s)
    }
}
