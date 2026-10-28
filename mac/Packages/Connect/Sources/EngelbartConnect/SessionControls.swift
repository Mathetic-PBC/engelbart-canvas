import Foundation
import EngelbartCore

// session.cjs, the last part: a step answered (need), the person's controls (stop, stopJob, retryMemory, minimize,
// dismiss), the rows placed on the project, quitting (suspendAll) and resuming (resume, revive).

extension Connect {
    /// A request the window shows was answered: 'open', 'done', 'skip'.
    public func need(_ id: String, _ needId: String, _ action: String) async throws -> JSONValue {
        let s = try get(id)
        guard let found = s.needs.first(where: { $0.id == needId && !$0.closed }) else { return snapshot(s) }
        guard ["open", "done", "skip"].contains(action) else { throw ConnectError("failed", "Unknown action") }
        let shown = ConnectSources.shownName(found.app)
        if found.kind == Self.signinHere {
            if action == "skip" { closeNeed(s, found, "skip"); return snapshot(s) }
            return signInHere(s, found)
        }
        if Self.signinApps.contains(found.app) && found.own == nil && action != "skip" {
            if action == "open" { return await ownSignIn(s, found) }
            if ownStatus(found.app).connected { closeNeed(s, found, "done") } else { found.error = "Still not signed in to \(shown)."; emit(s) }
            return snapshot(s)
        }
        if action == "done" && found.own == nil && Self.signinKinds.contains(found.kind) && deps.webSignIn != nil { return await signedInNow(s, found) }
        if action == "done" || action == "skip" { closeNeed(s, found, action); return snapshot(s) }
        found.error = ""
        if found.kind == "confirm" { closeNeed(s, found, "done"); return snapshot(s) }
        if let own = found.own {
            var opened = false
            if let open = deps.openBrowserApp, let ownId = found.ownId { opened = (try? await open(ownId)) != nil }
            found.opened = opened
            found.error = opened ? "" : "Open \(own) yourself: the agent's tab is there."
            if opened { logAction(s, nil, "Opened \(own)", who: "You") }
            emit(s)
            return snapshot(s)
        }
        if found.kind == "connector", let connectors = deps.connectors, isConnectorApp(found.app) {
            if found.busy { return snapshot(s) }
            if connectorConnected(found.app) { closeNeed(s, found, "done"); return snapshot(s) }
            found.busy = true; found.opened = true
            let app = found.app
            found.cancel = { connectors.cancel(app) }
            emit(s)
            Task { @MainActor in
                do {
                    _ = try await connectors.signIn(app)
                    found.busy = false; found.cancel = nil
                    if !found.closed { logAction(s, nil, "Connected \(shown)", who: "You"); closeNeed(s, found, "done") }
                } catch {
                    found.busy = false; found.cancel = nil
                    if found.closed { return }
                    found.opened = false
                    found.error = SessionText.line((error as? ConnectError)?.message ?? "Couldn't connect \(shown)", 200)
                    emit(s)
                }
            }
            watchStep(s, found)
            return snapshot(s)
        }
        if found.kind == "permission", let notes = deps.appleNotes, found.app == "Apple Notes" {
            found.busy = true; emit(s)
            let out = await notes.permission()
            found.busy = false
            if out.allowed { s.choices.permissions.notes = true; closeNeed(s, found, "done") } else { found.error = SessionText.line(out.error, 200); emit(s) }
            return snapshot(s)
        }
        if found.kind == "permission" { closeNeed(s, found, "done"); return snapshot(s) }
        guard let web = deps.webSignIn else { found.error = "Open \(shown) in your browser to finish this, then come back."; emit(s); return snapshot(s) }
        // Round 3: their browser's sign-ins declined: read in their own browser when agents may use it, else left out.
        if Self.signinKinds.contains(found.kind) && !s.choices.keychain {
            closeNeed(s, found, readElsewhere(s, found.app, web.browserName()) ? "done" : "skip", why: "its sign-in can only be used with your browser’s sign-ins, which you turned down")
            return snapshot(s)
        }
        if Self.signinKinds.contains(found.kind) && !web.supports(found.app) {
            let name = await web.openApp(found.app)
            found.opened = !name.isEmpty
            if !name.isEmpty { found.browser = name; logAction(s, nil, "Opened \(shown) in \(name)", who: "You") }
            else { found.error = "Couldn't open \(shown). Open it in your browser, then come back." }
            emit(s)
            return snapshot(s)
        }
        if Self.signinKinds.contains(found.kind) && web.supports(found.app) {
            if found.busy { return snapshot(s) }
            let signal = AbortSignal()
            found.busy = true
            found.cancel = { signal.abort() }
            emit(s)
            let app = found.app
            Task { @MainActor in
                let out = await web.signIn(app, signal: signal, onOpened: { name in Task { @MainActor in
                    found.opened = true; found.browser = name; self.logAction(s, nil, "Opened \(shown)'s sign-in in \(name)", who: "You"); self.emit(s)
                } }, denied: signInDenied)
                if signal.isAborted && out.status == "cancelled" { return }
                found.busy = false; found.cancel = nil
                found.note = noteFor(app, found.kind)
                if !out.browser.isEmpty { found.browser = out.browser }
                if found.closed || out.status == "cancelled" { return }
                switch out.status {
                case "signed-in": logAction(s, nil, "Signed in to \(shown) from \(out.browser)", who: "You"); closeNeed(s, found, "done")
                case "held-elsewhere": closeNeed(s, found, readElsewhere(s, app, out.browser) ? "done" : "skip", why: "its sign-in doesn’t work in Engelbart"); emit(s)
                case "unsupported", "no-browser": found.error = "Couldn't open \(shown) in your browser. Sign in there, then press I’m signed in."; emit(s)
                case "denied":
                    if let bid = out.browserId { signInDenied.add(bid) }
                    closeNeed(s, found, "skip", why: "macOS didn't allow \(out.browser.isEmpty ? "your browser" : out.browser)'s sign-ins")
                    notice(s, SessionText.skippedLine(out.browser, [app]))
                    emit(s)
                default:
                    found.error = out.status == "timeout" ? "Still not signed in to \(shown) in \(out.browser). Log in to keep waiting, or skip it." : SessionText.line(out.status, 200)
                    emit(s)
                }
            }
            return snapshot(s)
        }
        found.error = "Open \(shown) in your browser to finish this, then come back."
        emit(s)
        return snapshot(s)
    }

    /// "I'm signed in" on a sign-in popup: the sign-in copied and checked before the step closes.
    func signedInNow(_ s: ConnectSession, _ found: ConnectNeed) async -> JSONValue {
        if found.busy, let cancel = found.cancel { cancel(); found.cancel = nil; found.busy = false }
        if found.busy { return snapshot(s) }
        found.busy = true; found.error = ""; emit(s)
        let web = deps.webSignIn!
        var q = WebSignIn.Quiet(signedIn: false)
        if web.supports(found.app) { q = await web.signInQuiet(found.app, denied: signInDenied) }
        else { q.signedIn = await web.copyBlind(found.app, denied: signInDenied) }
        found.busy = false
        if found.closed { return snapshot(s) }
        let shown = ConnectSources.shownName(found.app)
        if q.signedIn {
            for other in ConnectSources.sharesSignIn(found.app) { signInChecked[other] = checkedAs(other, q) }
            logAction(s, nil, "Signed in to \(shown)\(q.browser.isEmpty ? "" : " from \(q.browser)")", who: "You")
            closeNeed(s, found, "done")
            return snapshot(s)
        }
        if q.held { closeNeed(s, found, readElsewhere(s, found.app, found.browser ?? "") ? "done" : "skip", why: "its sign-in doesn’t work in Engelbart"); return snapshot(s) }
        if !q.refused.isEmpty {
            if !q.refusedId.isEmpty { signInDenied.add(q.refusedId) }
            closeNeed(s, found, "skip", why: "macOS didn't allow \(q.refused)'s sign-ins")
            notice(s, SessionText.skippedLine(q.refused, [found.app]))
            emit(s)
            return snapshot(s)
        }
        if found.opened && s.choices.browserAgents != nil && readElsewhere(s, found.app, found.browser ?? "") { closeNeed(s, found, "done"); return snapshot(s) }
        found.error = "Still not signed in to \(shown)\(found.browser.map { " in \($0)" } ?? "")."
        emit(s)
        return snapshot(s)
    }

    /// Sign in on a Zotero or GitHub step: Engelbart's own sign-in started here.
    func ownSignIn(_ s: ConnectSession, _ found: ConnectNeed) async -> JSONValue {
        let app = found.app, shown = ConnectSources.shownName(app)
        if ownStatus(app).connected { closeNeed(s, found, "done"); return snapshot(s) }
        guard let connect = app == "Zotero" ? deps.zotero.connect : deps.github.connect else { found.error = "Sign in to \(shown) in Settings, then come back."; emit(s); return snapshot(s) }
        if found.busy { return snapshot(s) }
        found.busy = true; found.error = ""; emit(s)
        var out: JSONValue
        do { out = try await connect() } catch { out = ["failed": .string((error as? ConnectError)?.message ?? "Couldn't start the \(shown) sign-in.")] }
        found.busy = false
        if found.closed { return snapshot(s) }
        if out["connected"] == .bool(true) { logAction(s, nil, "Signed in to \(shown)", who: "You"); closeNeed(s, found, "done"); return snapshot(s) }
        if JS.truthy(out["failed"]) || !JS.truthy(out["pending"]) {
            found.opened = false
            let said = JS.truthy(out["failed"]) ? JS.string(out["failed"]) : JS.truthy(out["error"]) ? JS.string(out["error"]) : "Couldn't open the \(shown) sign-in. Try again."
            found.error = SessionText.line(said, 200)
            emit(s)
            return snapshot(s)
        }
        found.opened = true
        found.code = JS.string(out["pending"]?["userCode"])
        logAction(s, nil, "Opened the \(shown) sign-in in your browser", who: "You")
        watchStep(s, found)
        emit(s)
        return snapshot(s)
    }

    /// A step the agents' browser took for a job, into that job's session's action log.
    public func logJob(_ jobId: String, _ text: String) {
        for s in sessions.values { if let job = s.jobs.first(where: { $0.id == jobId }) { logAction(s, job, text); return } }
    }

    /// The person closed a window shown to them.
    public func windowClosed(_ jobId: String) {
        for s in sessions.values {
            guard let found = s.needs.first(where: { !$0.closed && $0.jobs.contains(jobId) }) else { continue }
            guard let web = deps.webSignIn, web.supports(found.app) else { closeNeed(s, found, "done"); continue }
            Task { @MainActor in
                let yes = await web.signedIn(found.app)
                if found.closed { return }
                if yes { closeNeed(s, found, "done"); return }
                found.opened = false
                found.error = "Not signed in to \(ConnectSources.shownName(found.app)) yet."
                emit(s)
            }
        }
    }

    public func stopJob(_ id: String, _ jobId: String) throws -> JSONValue {
        let s = try get(id)
        guard let job = s.jobs.first(where: { $0.id == jobId }) else { return snapshot(s) }
        if job.status == "queued" { job.status = "stopped"; job.ended = now(); logAction(s, job, "Stopped") } else { job.controller?.abort() }
        emit(s); maybeMemory(s)
        return snapshot(s)
    }

    public func stop(_ id: String) throws -> JSONValue {
        let s = try get(id)
        s.stopped = true
        s.interviewController?.abort()
        s.controllers.forEach { $0.abort() }
        for job in s.jobs where job.status == "queued" { job.status = "stopped"; job.ended = now() }
        for found in s.needs where !found.closed { closeNeed(s, found, "skip") }
        releaseGrant(s)
        if ["waiting", "writing", "cleaning"].contains(s.memory["status"]?.string ?? "") { s.memory["status"] = "stopped" }
        logAction(s, nil, "Stopped everything", who: "You")
        emit(s)
        return snapshot(s)
    }

    /// MEMORY.md again, after it failed.
    public func retryMemory(_ id: String) throws -> JSONValue {
        let s = try get(id)
        if s.stopped { throw ConnectError("failed", "This import was stopped") }
        if s.jobs.contains(where: { ($0.kind == "memory" || $0.kind == "redact") && !Self.ended.contains($0.status) }) { return snapshot(s) }
        s.jobs.removeAll { $0.kind == "memory" || $0.kind == "redact" }
        s.memoryQueued = false
        if s.memoryDraft != nil {
            s.memoryQueued = true; s.memory["status"] = "cleaning"; s.memory["error"] = ""
            dispatch(s, kind: "redact", source: "memory", apps: [], label: "MEMORY.md, secrets out")
        } else { maybeMemory(s) }
        emit(s)
        return snapshot(s)
    }

    public func setMinimized(_ id: String, _ value: Bool) throws -> JSONValue { let s = try get(id); s.minimized = value; emit(s); return snapshot(s) }

    @discardableResult
    public func dismiss(_ id: String) throws -> Bool { let s = try get(id); s.dismissed = true; emit(s); return true }

    /// Onboarding made the project: the staged notes go into it, and later ones straight there. → how many went in
    public func attachProject(dataRoot: String, id: String, projectId: String, workspaceId: String? = nil) async -> Int {
        guard let s = sessions[id], s.dataRoot == dataRoot else { return 0 }
        s.projectId = projectId
        s.projectDir = await deps.store.projectDir(projectId)
        let written = (try? await Notes.flushStaged(URL(fileURLWithPath: s.dir), projectId: projectId, projects: deps.store)) ?? []
        if let workspaceId, JS.test(workspaceId, Self.idRE, options: .caseInsensitive) { s.workspaceId = workspaceId }
        await placeRows(s, s.rows)
        emit(s)
        return written.count
    }

    /// What the session brought into the library, put on the project's list (never into a workspace's context, but
    /// onboarding's Welcome workspace).
    func keepRow(_ s: ConnectSession, _ row: LibraryRow) {
        guard JS.test(row.id, Self.idRE, options: .caseInsensitive), !s.rows.contains(row.id) else { return }
        s.rows.append(row.id)
        if s.projectId != nil { Task { await placeRows(s, [row.id]) } }
    }

    func placeRows(_ s: ConnectSession, _ ids: [String]) async {
        guard !ids.isEmpty, let projectId = s.projectId else { return }
        let before = s.placing
        let task = Task { @MainActor in
            await before?.value
            guard await deps.store.dataRoot() == s.dataRoot else { return }
            guard let kept = try? await deps.store.keepInProject(projectId: projectId, rowIds: ids) else { return }
            for row in ids where !kept.removed.contains(row) { s.inProject.insert(row) }
            var linked = 0
            if let workspaceId = s.workspaceId, s.mode == "onboarding" {
                let adding = ids.filter { !s.inWorkspace.contains($0) }
                if !adding.isEmpty, let done = try? await deps.store.linkToWorkspace(projectId: projectId, workspaceId: workspaceId, rowIds: adding) { done.forEach { s.inWorkspace.insert($0) }; linked = done.count }
            }
            if !kept.listed.isEmpty || linked > 0 { deps.placed(projectId) }
        }
        s.placing = task
        await task.value
    }

    // MARK: quitting and resuming

    /// Engelbart quits, or switches library: every session still going is saved as it is and its agents end.
    public func suspendAll() {
        for s in Array(sessions.values) {
            if !s.stopped && !s.dismissed {
                s.suspended = true
                save(s, force: true)
                s.interviewController?.abort()
                s.controllers.forEach { $0.abort() }
                releaseGrant(s)
            }
            sessions[s.id] = nil
            resumed.remove(s.dataRoot)
        }
        deps.browser?.closeAll()
    }

    static func unfinished(_ saved: JSONValue, now: Date = Date()) -> Bool {
        guard saved.object != nil, saved["stopped"] != .bool(true), saved["dismissed"] != .bool(true) else { return false }
        guard let created = Time.parse(JS.string(saved["created"])), now.timeIntervalSince(created) <= resumeDays * 86_400 else { return false }
        if JS.truthy(saved["blocked"]) || stalledOnProvider(saved) { return true }
        let jobs = saved["jobs"]?.array ?? []
        if saved["done"] != .bool(true) && saved["finished"] != .bool(true) { return true }
        if jobs.contains(where: { work.contains(JS.string($0["kind"])) && !ended.contains(JS.string($0["status"])) }) { return true }
        return ["waiting", "writing", "cleaning"].contains(saved["memory"]?["status"]?.string ?? "")
    }

    /// A run saved before runs waited for their provider: nothing came in, its agents failed as their CLI needed the person.
    static func stalledOnProvider(_ saved: JSONValue) -> Bool {
        guard saved.object != nil, JS.truthy(saved["direct"]), saved["stopped"] != .bool(true) else { return false }
        let work = (saved["jobs"]?.array ?? []).filter { Self.work.contains(JS.string($0["kind"])) }
        if work.isEmpty || work.contains(where: { $0["status"]?.string == "done" }) { return false }
        if (saved["counts"]?["notes"]?.double ?? 0) + (saved["counts"]?["items"]?.double ?? 0) > 0 { return false }
        return work.contains { $0["status"]?.string == "failed" && ProviderFailure.needsProvider(message: JS.string($0["error"])) }
    }

    func keptPaths(_ value: JSONValue?) -> [String: String] {
        var out: [String: String] = [:]
        for (app, file) in value?.object ?? [:] {
            guard let real = file.string.flatMap({ Readers.expandPath(homeDir, $0) }), real.hasPrefix(homeDir + "/"), Readers.exists(real), ConnectSources.apps[app] != nil || app == "GitHub" else { continue }
            out[app] = real
        }
        return out
    }

    func keptRecalls(_ dir: String) -> [String: String] {
        var out: [String: String] = [:]
        let folder = (dir as NSString).appendingPathComponent("memories")
        for name in ((try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []) where name.hasSuffix(".md") {
            let app = String(name.dropLast(3))
            guard ConnectSources.apps[app] != nil, let text = try? String(contentsOfFile: (folder as NSString).appendingPathComponent(name), encoding: .utf8) else { continue }
            out[app] = text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return out
    }

    static func keptTool(_ tool: JSONValue?) -> ExtraTool? {
        guard let name = tool?["name"]?.string, !name.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        let sites = Array((tool?["sites"]?.array ?? []).compactMap(\.string).filter { JS.test($0, #"^[a-z0-9.-]{1,200}$"#, options: .caseInsensitive) }.prefix(12))
        let website = tool?["website"]?.string.flatMap { JS.test($0, "^https?://", options: .caseInsensitive) ? String($0.prefix(300)) : nil } ?? ""
        return ExtraTool(name: SessionText.line(name, 60), website: website, sites: sites)
    }

    /// One saved session made live again: its unfinished jobs queued, the librarian asked again if it had not answered.
    @discardableResult
    func revive(dataRoot: String, id: String, saved: JSONValue) async -> ConnectSession {
        let dir = (dataRoot as NSString).appendingPathComponent(".connect/\(id)")
        let usable = readyNow()
        let stalled = Self.stalledOnProvider(saved)
        let savedProvider = JS.string(saved["provider"])
        let provider = usable.contains(savedProvider) ? savedProvider : usable.first ?? (ConnectModels.providers.contains(savedProvider) ? savedProvider : "anthropic")
        var projectId: String?, projectDir: String?
        if let pid = saved["projectId"]?.string, JS.test(pid, Self.idRE, options: .caseInsensitive), let d = await deps.store.projectDir(pid) { projectId = pid; projectDir = d }
        let kept = saved["memory"]?["status"]?.string == "saved"
        let folders = keptPaths(saved["picked"]?["folders"])
        let s = ConnectSession(id: id, mode: saved["mode"]?.string == "existing" && projectId != nil ? "existing" : "onboarding", dataRoot: dataRoot, created: JS.string(saved["created"]),
                               choices: SessionText.cleanChoices(saved["choices"] ?? .object([:]), homeDir: homeDir, alsoPicked: folders.values.map { Readers.isDir($0) ? $0 : ($0 as NSString).deletingLastPathComponent }),
                               choice: choiceFor(provider))
        s.picked = (folders, keptPaths(saved["picked"]?["exports"]))
        s.chat = (saved["chat"]?.array ?? []).compactMap { e in ["agent", "user"].contains(e["role"]?.string ?? "") ? ChatEntry(e.object ?? [:]) : nil }
        s.thinking = false; s.activity = ""; s.done = saved["done"] == .bool(true); s.finished = saved["finished"] == .bool(true); s.minimized = true
        s.log = Array((saved["log"]?.array ?? []).suffix(Self.maxLog))
        s.interviewSession = saved["interviewSession"]?.string
        for (source, apps) in saved["found"]?.object ?? [:] where source != "error" { s.found[source] = apps.object ?? [:] }
        s.projectId = projectId; s.projectDir = projectDir
        s.waitingForSurvey = saved["waiting"] == .bool(true)
        s.recalls = keptRecalls(dir)
        if kept { s.memory = saved["memory"]?.object ?? s.memory }
        s.memoryQueued = kept
        s.skipped = Set((saved["skipped"]?.array ?? []).compactMap(\.string))
        s.skippedSources = Set((saved["skippedSources"]?.array ?? []).compactMap(\.string).filter { ConnectSources.sourceOf($0) != nil })
        s.fallback = Set((saved["fallback"]?.array ?? []).compactMap(\.string).filter { ConnectSources.apps[$0] != nil })
        s.connected = Set((saved["connected"]?.array ?? []).compactMap(\.string).filter { ConnectSources.apps[$0] != nil })
        let ids = { (k: String) in (saved[k]?.array ?? []).compactMap(\.string).filter { JS.test($0, Self.idRE, options: .caseInsensitive) } }
        s.rows = ids("rows"); s.inProject = Set(ids("inProject")); s.inWorkspace = Set(ids("inWorkspace"))
        s.workspaceId = projectId != nil ? saved["workspaceId"]?.string.flatMap { JS.test($0, Self.idRE, options: .caseInsensitive) ? $0 : nil } : nil
        s.gmailThreads = max(0, saved["gmailThreads"]?.int ?? 0)
        s.manual = saved["manual"] == .bool(true)
        s.allowed = Set((saved["allowed"]?.array ?? []).compactMap(\.string).filter { ConnectSources.apps[$0] != nil })
        for (app, list) in saved["approved"]?.object ?? [:] where Tools.approvalApps.contains(app) { s.approved[app] = Set((list.array ?? []).compactMap(\.string).prefix(2000)) }
        s.leftOut = (saved["leftOut"]?.array ?? []).compactMap { e in
            guard let app = e["app"]?.string, ConnectSources.apps[app] != nil || app == "GitHub", let why = e["why"]?.string else { return nil }
            return (app, SessionText.line(why, 200))
        }
        if s.chat.allSatisfy({ JS.truthy($0.value["opener"]) }) { s.chat = [] }
        for job in saved["jobs"]?.array ?? [] {
            let kind = JS.string(job["kind"])
            guard ConnectSession.priority[kind] != nil else { continue }
            if (kind == "memory" || kind == "redact") && !kept { continue }
            let status = JS.string(job["status"])
            let again = !Self.ended.contains(status) || (stalled && status == "failed" && ProviderFailure.needsProvider(message: JS.string(job["error"])))
            let apps = (job["apps"]?.array ?? []).compactMap(\.string).filter { ConnectSources.apps[$0] != nil || $0 == "GitHub" }
            let find = kind == "survey" && (job["find"] == .bool(true) || (job["key"]?.string?.hasPrefix("find:") ?? false))
            s.seq += 1
            let source = JS.string(job["source"])
            let j = ConnectJob(id: job["id"]?.string.flatMap { JS.test($0, Self.idRE, options: .caseInsensitive) ? $0 : nil } ?? IDs.new(),
                               key: job["key"]?.string ?? "\(find ? "find" : kind):\(source):\(apps.sorted().joined(separator: ","))", kind: kind, seq: s.seq, source: source, apps: apps,
                               label: SessionText.line(job["label"], 120), plan: SessionText.clip(job["plan"]?.string, 8000))
            j.find = find
            if let sites = job["extra"]?["sites"]?.array { j.extra = (Array(sites.compactMap(\.string).filter { JS.test($0, #"^[a-z0-9.-]{1,200}$"#, options: .caseInsensitive) }.prefix(12)), Self.keptTool(job["extra"]?["tool"])) }
            j.status = again ? "queued" : status
            j.skipped = job["skipped"] == .bool(true)
            j.notes = job["notes"]?.int ?? 0; j.items = job["items"]?.int ?? 0
            j.titles = (job["titles"]?.array ?? []).prefix(80).map { SessionText.line($0, 120) }
            j.summary = again ? "" : SessionText.line(job["summary"], 500)
            j.error = again ? "" : SessionText.line(job["error"], 300)
            j.started = again ? nil : job["started"]?.string
            j.ended = again ? nil : job["ended"]?.string
            if job["route"]?.string == "browser" && kind == "import" && s.choices.browserAgents != nil { j.route = "browser" }
            s.jobs.append(j)
        }
        // A survey that waited on a sign-in card when Engelbart closed: it runs now, and asks again itself.
        for (source, apps) in s.found {
            for (app, value) in apps where JS.truthy(value["signIn"]) && !s.skipped.contains(app) {
                var e = value.object ?? [:]; e["signIn"] = nil; s.found[source]![app] = .object(e)
                if !s.jobs.contains(where: { $0.kind == "survey" && $0.apps.contains(app) }) {
                    s.seq += 1
                    s.jobs.append(ConnectJob(key: "survey:\(source):\(app)", kind: "survey", seq: s.seq, source: source, apps: [app], label: "Looking through \(ConnectSources.shownName(app))", plan: ""))
                }
            }
        }
        let waited: (String, String)? = saved["blocked"]?["provider"]?.string.flatMap { ConnectModels.providers.contains($0) ? ($0, JS.string(saved["blocked"]?["error"])) : nil }
            ?? (stalled ? (provider, "\(ConnectModels.providerNames[provider]!) is not connected") : nil)
        s.blocked = waited != nil && usable.isEmpty && s.choices.direct != nil ? (waited!.0, SessionText.line(waited!.1, 200), now()) : nil
        if stalled { s.memory = ["status": "waiting", "path": .string(Memory.path(URL(fileURLWithPath: dataRoot)).path), "error": ""] }
        sessions[id] = s
        s.dirs = dirsOf(s)
        if let d = s.choices.direct {
            for need in saved["needs"]?.array ?? [] {
                let app = JS.string(need["app"]), kind = JS.string(need["kind"])
                guard !app.isEmpty, need["closed"] != .bool(true), Self.signinKinds.contains(kind) || kind == "connector" || kind == Self.signinHere, ConnectSources.apps[app] != nil, d.apps.contains(app) else { continue }
                if s.skipped.contains(app) || s.jobs.contains(where: { $0.kind == "import" && $0.apps.contains(app) }) { continue }
                if (Self.signinApps.contains(app) && ownStatus(app).connected) || (kind == "connector" && connectorConnected(app)) { directImport(s, app); continue }
                if ConnectSources.apps[app]?.reach == .web { s.holdSet(app, source: ImportFlow.groupOfApp(app) ?? "other"); recoverHeld(s, app); continue }
                signInCard(s, app, kind: kind == "connector" ? "connector" : "signin")
            }
        }
        var grantOpen = false
        if s.choices.direct == nil && !s.finished && !s.stopped && (!s.chat.isEmpty || !s.jobs.isEmpty) {
            if let open = openGrant(s) {
                for row in open.value["grant"]?["rows"]?.array ?? [] where row["tool"] == nil { let id = JS.string(row["id"]); s.holdSet(id, source: ConnectSources.sourceOfApp(id) ?? "other", consent: true) }
            } else { _ = askGrant(s) }
            grantOpen = openGrant(s) != nil
            for (source, apps) in s.found {
                for (app, value) in apps where JS.truthy(value["connector"]) && isConnectorApp(app) && s.allowed.contains(app) && !s.skipped.contains(app) {
                    if connectorConnected(app) { s.put(source, app, ["reach": "connector", "survey": "running"]); dispatch(s, kind: "survey", source: source, apps: [app], label: "Looking through \(ConnectSources.shownName(app))") }
                    else { s.holdSet(app, source: source); signInCard(s, app, kind: "connector") }
                }
            }
        }
        logAction(s, nil, "Picked up again after Engelbart closed")
        emit(s)
        pump(s)
        if s.chat.isEmpty && s.jobs.isEmpty {
            s.thinking = true; s.activity = "Looking at what you picked…"
            Task { await opening(s) }
        } else if s.choices.direct != nil {
            if !s.finished { Task { await directOpening(s) } }
        } else if grantOpen {
            Task { await afterGrant(s) }
        } else if !s.done && !s.finished {
            if let last = s.chat.last {
                if last.value["role"]?.string == "user" { let t = SessionText.line(last.value["text"], 2000); turnSoon(s, "\(t) (Engelbart closed before you answered this. Answer it now.)") }
                else if saved["thinking"] == .bool(true) || (s.waitingForSurvey && !surveying(s)) { turnSoon(s, "Engelbart closed while you were working, and has opened again. What the surveys found is in <found>. Go on from where you were.") }
            } else { turnSoon(s, "Start.") }
        }
        maybeMemory(s)
        return s
    }

    /// The sessions of this library still going when Engelbart closed start again where they were. → how many
    @discardableResult
    public func resume(dataRoot: String) async -> Int {
        if dataRoot.isEmpty || resumed.contains(dataRoot) { return 0 }
        resumed.insert(dataRoot)
        let folder = (dataRoot as NSString).appendingPathComponent(".connect")
        var n = 0
        for id in ((try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []).sorted() where JS.test(id, Self.idRE, options: .caseInsensitive) && sessions[id] == nil {
            guard let saved = Files.readJSON(URL(fileURLWithPath: folder).appendingPathComponent("\(id)/session.json")), Self.unfinished(saved) else { continue }
            await revive(dataRoot: dataRoot, id: id, saved: saved)
            n += 1
        }
        return n
    }

    /// The sessions of a data root that are not dismissed, newest first.
    public func list(dataRoot: String? = nil) -> [JSONValue] {
        sessions.values.filter { !$0.dismissed && (dataRoot == nil || $0.dataRoot == dataRoot) }.sorted { $0.created > $1.created }.map(snapshot)
    }

    /// What the choose screen offers: the providers that can run now, each with its pinned model.
    public func providers() -> [JSONValue] {
        let usable = readyNow()
        return ConnectModels.providers.map { p in let c = choiceFor(p); return ["provider": .string(p), "name": .string(ConnectModels.providerNames[p]!), "modelName": .string(c.modelName), "effort": .string(c.effort), "ready": .bool(usable.contains(p))] }
    }

    public func cancelSignIn(_ id: String, _ app: String) throws -> Bool { _ = try get(id); deps.connectors?.cancel(app); return true }

    /// A data root wiped (test mode's reset): its sessions stopped and dropped, every sign-in answer forgotten.
    public func forget(dataRoot: String) {
        for (id, s) in sessions where s.dataRoot == dataRoot {
            s.stopped = true
            s.controllers.forEach { $0.abort() }
            s.interviewController?.abort()
            for need in s.needs { need.watch?.cancel(); need.cancel?() }
            for job in s.jobs { deps.browser?.close(job.id) }
            sessions[id] = nil
        }
        resumed.remove(dataRoot)
        signInChecked = [:]
        signInChecking = [:]
        signInDenied.clear()
    }

    public func state(_ id: String) throws -> JSONValue { snapshot(try get(id)) }
    public func has(_ id: String) -> Bool { sessions[id] != nil }
}
