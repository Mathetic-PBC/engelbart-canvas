import Foundation
import EngelbartCore

// session.cjs, the second part: the web apps' sign-ins (checked before the surveys, brought back when lost), the steps an
// agent hands the person ("Needs you"), recovery's one card, skipping.

extension Connect {
    // MARK: what starts a session's work

    /// The surveys and recalls a session starts with. An app in `held` is still signed out or refused: held.
    func startWork(_ s: ConnectSession, held: Set<String> = [], only: [String]? = nil) {
        for source in ConnectSources.sourceIds {
            guard let choice = s.choices.sources[source], choice.on else { continue }
            for app in choice.apps {
                if let only, !only.contains(app) { continue }
                if !mayReach(s, app) { continue }
                let reach = ConnectSources.apps[app]?.reach
                if reach == .web {
                    if !s.choices.permissions.browser { s.put(source, app, ["reach": "web", "left": "They did not let the agents use their accounts, so this app is left out."]); continue }
                    if held.contains(app) { s.holdSet(app, source: source); s.put(source, app, ["reach": "web", "survey": "running", "signIn": "waiting: not signed in yet"]); continue }
                    s.put(source, app, ["reach": "web", "survey": "running"])
                    dispatch(s, kind: "survey", source: source, apps: [app], label: "Looking through \(ConnectSources.shownName(app))")
                } else if reach == .connector {
                    let connected = connectorConnected(app)
                    if !connected && connectorFallback(s, app) {
                        s.put(source, app, ["reach": "connector", "fallback": "Its connector does not serve this account: it is read through its website instead, by its own import. Do not offer or dispatch it."])
                    } else if connected {
                        s.put(source, app, ["reach": "connector", "survey": "running"])
                        dispatch(s, kind: "survey", source: source, apps: [app], label: "Looking through \(ConnectSources.shownName(app))")
                    } else if deps.connectors != nil {
                        // Allowed but not connected (2026-10-16): its Connect step now, held; connected, its survey starts.
                        s.put(source, app, ["reach": "connector", "connector": "Engelbart asked the person to connect it, on a card of its own. Do not offer it or ask about it: its survey reports once they have connected it."], news: true)
                        s.holdSet(app, source: source)
                        signInCard(s, app, kind: "connector")
                    } else { s.put(source, app, ["reach": "connector", "needs": "connector"]) }
                }
            }
        }
        if s.choices.permissions.recall && s.choices.permissions.browser {
            let chats = s.choices.sources["chats"]
            for app in ConnectSources.recallApps(chats?.on == true ? chats!.apps : []) {
                if let only, !only.contains(app) { continue }
                if !mayReach(s, app) { continue }
                if var h = s.held[app] { h.recall = true; s.held[app] = h }
                else { dispatch(s, kind: "recall", source: "chats", apps: [app], label: "Asking \(ConnectSources.shownName(app)) what it remembers") }
            }
        }
    }

    /// A held app's sign-in settled: done starts its survey and recall; skip leaves it out, and the librarian hears.
    func releaseHeld(_ s: ConnectSession, _ app: String, _ how: String) {
        guard let held = s.held[app] else { return }
        s.unhold(app)
        var entry = s.found[held.source]?[app]?.object ?? [:]
        entry["signIn"] = nil
        if how == "skip" || s.stopped {
            s.put(held.source, app, ["reach": .string(entry["reach"]?.string ?? "web"), "skipped": "The person skipped this app for this run: leave it out, and do not offer, ask about or hand it over again."], news: true)
            s.surveyNews.append(app)
            if s.waitingForSurvey && !s.thinking { wake(s) }
            return
        }
        if s.choices.direct != nil {
            s.put(held.source, app, .object(entry))
            directImport(s, app)
            if held.recall { dispatch(s, kind: "recall", source: "chats", apps: [app], label: "Asking \(ConnectSources.shownName(app)) what it remembers") }
            return
        }
        entry["survey"] = .string(s.finished ? "not run: Import was pressed first" : "running")
        s.put(held.source, app, .object(entry))
        if !s.finished { dispatch(s, kind: "survey", source: held.source, apps: [app], label: "Looking through \(ConnectSources.shownName(app))") }
        if held.recall { dispatch(s, kind: "recall", source: "chats", apps: [app], label: "Asking \(ConnectSources.shownName(app)) what it remembers") }
    }

    // MARK: sign-ins checked on the choose screen and before the surveys

    func checkedAs(_ app: String, _ q: WebSignIn.Quiet) -> JSONValue {
        let was = signInChecked[app]
        if q.signedIn {
            let kept = q.browser.isEmpty && was?["status"]?.string == "signed-in" ? was : nil
            let profile = !q.browser.isEmpty ? (q.profile ?? "") : (kept?["profile"]?.string ?? "")
            var o: [String: JSONValue] = ["status": "signed-in", "browser": .string(!q.browser.isEmpty ? q.browser : (kept?["browser"]?.string ?? "")), "browserId": ""]
            if !profile.isEmpty { o["profile"] = .string(profile) }
            if q.unchecked { o["unchecked"] = true }
            return .object(o)
        }
        if !q.refused.isEmpty { return ["status": "refused", "browser": .string(q.refused), "browserId": .string(q.refusedId)] }
        if q.noBrowser { return ["status": "no-browser", "browser": "", "browserId": ""] }
        if q.held { return ["status": "held-elsewhere", "browser": .string(deps.webSignIn?.browserName() ?? ""), "browserId": ""] }
        return ["status": "signed-out", "browser": "", "browserId": ""]
    }

    func signsInAtAll(_ app: String) -> Bool { deps.webSignIn?.canSignIn(app) ?? false }

    /// What to tell the person before a ticked web app's check asks macOS → { browser, note, profiles, opens }.
    public func signInNote(_ app: String, route: String = "") async -> JSONValue {
        guard let web = deps.webSignIn, web.supports(app) else { return ["browser": "", "note": "", "profiles": [], "opens": ""] }
        let browserRoute = route == "browser"
        let opens = browserRoute ? web.opensIn(app) : ""
        if !browserRoute, await web.signedIn(app) { return ["browser": "", "note": "", "profiles": [], "opens": .string(opens)] }
        let profiles = profilesToAsk(app)
        let target = web.keychainTarget(app, holdersOnly: !browserRoute)
        let browser = target?.name ?? profiles.first?.browser ?? ""
        let list: JSONValue = .array(profiles.map(\.json))
        guard let target, !signInDenied.has(target.id) else { return ["browser": .string(browser), "note": "", "profiles": list, "opens": .string(opens)] }
        return ["browser": .string(target.name), "note": .string(web.keychainNote(app, holdersOnly: !browserRoute)), "profiles": list, "opens": .string(opens)]
    }

    func profilesToAsk(_ app: String) -> [WebSignIn.Holder] {
        guard let web = deps.webSignIn else { return [] }
        let list = web.holdersOf(app).filter { !signInDenied.has($0.browserId) }
        if list.count < 2 { return [] }
        if let pick = web.picked(app), list.contains(where: { $0.browserId == pick.browser && $0.profileId == pick.profile }) { return [] }
        return list
    }

    public func signInPick(_ app: String, browser: String, profile: String) -> Bool {
        guard let web = deps.webSignIn, web.supports(app) else { return false }
        return web.choose(app, browser: browser, profile: profile)
    }

    /// A web app ticked on the choose screen: its sign-in brought over from a browser holding it → { status, browser, profile? }.
    public func signInCheck(_ app: String, retry: Bool = false) async -> JSONValue {
        guard let web = deps.webSignIn, signsInAtAll(app) else { return ["status": "", "browser": ""] }
        if let t = signInChecking[app] { return await t.value }
        if retry, let was = signInChecked[app]?["browserId"]?.string, !was.isEmpty { signInDenied.remove(was) }
        let task = Task<JSONValue, Never> { @MainActor in
            let out = checkedAs(app, await web.signInQuiet(app, denied: signInDenied))
            signInChecked[app] = out
            signInChecking[app] = nil
            var o: [String: JSONValue] = ["status": out["status"] ?? "", "browser": out["browser"] ?? ""]
            if let p = out["profile"] { o["profile"] = p }
            return .object(o)
        }
        signInChecking[app] = task
        return await task.value
    }

    /// "Sign in" in Engelbart's own browser → { status: 'signed-in' | 'rejected' | 'closed' }.
    public func signInWindowOpen(_ app: String) async -> JSONValue {
        guard let window = deps.signInWindow, let web = deps.webSignIn, signsInAtAll(app) else { return ["status": "closed"] }
        let out = await window.open(app)
        if out == "signed-in" {
            web.signedInHere(app)
            for other in ConnectSources.sharesSignIn(app) { signInChecked[other] = ["status": "signed-in", "browser": "", "browserId": ""] }
            signInBrowserCancel(app)
            return ["status": "signed-in"]
        }
        return ["status": .string(out == "rejected" ? "rejected" : "closed")]
    }

    /// Google's Sign in on the choose screen, waited for in the person's browser (no time limit).
    public func signInBrowser(_ app: String) async -> JSONValue {
        guard let web = deps.webSignIn, web.supports(app) else { return ["status": "no-browser"] }
        let key = ConnectSources.signInGroup(app)
        if let wait = browserWaits[key] { return await wait.task.value }
        let signal = AbortSignal()
        let task = Task<JSONValue, Never> { @MainActor in
            let out = await web.signIn(app, signal: signal, timeoutMs: .infinity, denied: signInDenied)
            browserWaits[key] = nil
            if out.status == "signed-in" {
                var kept: [String: JSONValue] = ["status": "signed-in", "browser": .string(out.browser), "browserId": ""]
                if let p = out.profile { kept["profile"] = .string(p) }
                for other in ConnectSources.sharesSignIn(app) { signInChecked[other] = .object(kept) }
                var r: [String: JSONValue] = ["status": "signed-in", "browser": .string(out.browser)]
                if let p = out.profile { r["profile"] = .string(p) }
                return .object(r)
            }
            if out.status == "denied" {
                if let id = out.browserId { signInDenied.add(id) }
                for other in ConnectSources.sharesSignIn(app) { signInChecked[other] = ["status": "refused", "browser": .string(out.browser), "browserId": .string(out.browserId ?? "")] }
                return ["status": "refused", "browser": .string(out.browser)]
            }
            if out.status == "no-browser" { return ["status": "no-browser"] }
            return ["status": "cancelled"]
        }
        browserWaits[key] = (signal, task)
        return await task.value
    }

    /// Continue on the Keychain panel: macOS asked for that browser's sign-ins now, copying nothing.
    public func signInUnlock(_ app: String) async -> JSONValue {
        guard let web = deps.webSignIn, web.supports(app) else { return ["status": "allowed", "browser": ""] }
        let out = await web.unlock(app, denied: signInDenied)
        if out.status == "denied" {
            if let id = out.browserId { signInDenied.add(id) }
            for other in ConnectSources.sharesSignIn(app) { signInChecked[other] = ["status": "refused", "browser": .string(out.browser), "browserId": .string(out.browserId ?? "")] }
            return ["status": "refused", "browser": .string(out.browser)]
        }
        return ["status": "allowed", "browser": .string(out.browser)]
    }

    public func signInAnotherAccount(_ app: String) async -> JSONValue {
        guard let web = deps.webSignIn, browserWaits[ConnectSources.signInGroup(app)] != nil else { return ["opened": false, "browser": ""] }
        let out = await web.anotherAccount(app)
        return ["opened": .bool(out.opened), "browser": .string(out.browser)]
    }

    @discardableResult
    public func signInBrowserCancel(_ app: String = "") -> Bool {
        for (key, wait) in browserWaits where app.isEmpty || key == ConnectSources.signInGroup(app) { wait.signal.abort() }
        return true
    }

    @discardableResult
    public func signInWindowClose() -> Bool { deps.signInWindow?.close(); return true }

    struct SignInsChecked { var signedOut: [String] = []; var refused: [(String, String)] = []; var signedIn: [(String, String)] = []; var checking: [(String, Task<JSONValue, Never>)] = []; var elsewhere: [(String, String)] = [] }

    /// The ticked web apps' sign-ins, looked at before any survey starts (2026-10-09), together, at most 10 s.
    func signInsFirst(_ s: ConnectSession, only: [String]? = nil) async -> SignInsChecked {
        var out = SignInsChecked()
        guard let web = deps.webSignIn, s.choices.permissions.browser else { return out }
        var apps: [String] = []
        for source in ConnectSources.sourceIds { guard let c = s.choices.sources[source], c.on else { continue }
            for app in c.apps where (only == nil || only!.contains(app)) && mayReach(s, app) && ConnectSources.apps[app]?.reach == .web && signsInAtAll(app) && !apps.contains(app) { apps.append(app) } }
        if apps.isEmpty { return out }
        if !s.choices.keychain {
            for app in apps {
                if await web.signedIn(app) { out.signedIn.append((app, "")); logAction(s, nil, "Signed in to \(ConnectSources.shownName(app)) already") } else { out.signedOut.append(app) }
            }
            return out
        }
        var results: [String: JSONValue] = [:]
        var waiting: [(String, Task<JSONValue, Never>)] = []
        var quiet: [String] = []
        for app in apps {
            if let t = signInChecking[app] { waiting.append((app, t)) }
            else if let known = signInChecked[app], known["status"]?.string != "no-browser" { results[app] = known }
            else { quiet.append(app) }
        }
        var answers: [String: Task<JSONValue, Never>] = [:]
        for app in quiet { answers[app] = Task { @MainActor in let a = checkedAs(app, await web.signInQuiet(app, denied: signInDenied)); return a } }
        for (app, t) in waiting { _ = await t.value; results[app] = signInChecked[app] }
        if !quiet.isEmpty {
            let limit = deps.signInCheckMs ?? Self.signInCheckMs
            let deadline = Time.ms() + limit
            for app in quiet {
                let remaining = deadline - Time.ms()
                if remaining <= 0 { break }
                let t = answers[app]!
                let r = await withTaskGroup(of: JSONValue?.self) { g -> JSONValue? in
                    g.addTask { await t.value }
                    g.addTask { try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000)); return nil }
                    let first = await g.next() ?? nil
                    g.cancelAll()
                    return first
                }
                if let r { results[app] = r }
            }
        }
        for app in apps {
            guard let result = results[app] else { if let t = answers[app] { out.checking.append((app, t)) }; continue }
            switch result["status"]?.string {
            case "signed-in":
                let b = JS.string(result["browser"])
                out.signedIn.append((app, b))
                logAction(s, nil, b.isEmpty ? "Signed in to \(ConnectSources.shownName(app)) already" : "Signed in to \(ConnectSources.shownName(app)) from \(b)")
                if result["unchecked"] == .bool(true) { logAction(s, nil, "Couldn't check the \(ConnectSources.shownName(app)) sign-in (no answer): counted as signed in") }
            case "refused": out.refused.append((app, JS.string(result["browser"])))
            case "held-elsewhere": out.elsewhere.append((app, JS.string(result["browser"])))
            default: out.signedOut.append(app)
            }
        }
        return out
    }

    /// A sign-in still being checked when the surveys started: its app held, joining the run on its answer.
    func lateSignIn(_ s: ConnectSession, _ app: String, _ answer: Task<JSONValue, Never>) {
        logAction(s, nil, "Still checking the \(ConnectSources.shownName(app)) sign-in")
        Task { @MainActor in
            let result = await answer.value
            signInChecked[app] = result
            if s.stopped || s.held[app] == nil { return }
            let status = result["status"]?.string
            if status == "signed-in" {
                let b = JS.string(result["browser"])
                logAction(s, nil, b.isEmpty ? "Signed in to \(ConnectSources.shownName(app))" : "Signed in to \(ConnectSources.shownName(app)) from \(b)")
                if result["unchecked"] == .bool(true) { logAction(s, nil, "Couldn't check the \(ConnectSources.shownName(app)) sign-in (no answer): counted as signed in") }
                releaseHeld(s, app, "done"); emit(s); return
            }
            if status == "refused" {
                let b = JS.string(result["browser"])
                s.leave(app, "macOS didn't allow \(b.isEmpty ? "your browser" : b)'s sign-ins")
                skipApp(s, app)
                releaseHeld(s, app, "skip")
                notice(s, SessionText.skippedLine(b, [app]))
                emit(s); return
            }
            if status == "held-elsewhere" { heldElsewhere(s, app, JS.string(result["browser"])); emit(s); return }
            recoverHeld(s, app)
            emit(s)
        }
    }

    func noteFor(_ app: String, _ kind: String) -> String {
        guard kind == "signin" || kind == "password", let web = deps.webSignIn, web.supports(app) else { return "" }
        return web.keychainNote(app)
    }

    // MARK: needs you

    /// The app a need is for (2026-10-12/14/16).
    func needApp(_ job: ConnectJob, _ reason: String) -> String {
        if job.apps.isEmpty, let tool = job.extra?.tool, !tool.name.isEmpty { return tool.name }
        let first = job.apps.first ?? job.label
        let web = { (a: String) in ConnectSources.apps[a]?.reach == .web }
        if web(first) { return first }
        let said = reason.lowercased()
        let edge = { (c: Character?) in c.map { !($0.isLetter || $0.isNumber || $0 == "-") || !$0.isASCII } ?? true }
        let names = { (site: String) -> Bool in
            let want = site.lowercased()
            var search = said.startIndex
            while let r = said.range(of: want, range: search..<said.endIndex) {
                let before = r.lowerBound == said.startIndex ? nil : said[said.index(before: r.lowerBound)]
                let after = r.upperBound == said.endIndex ? nil : said[r.upperBound]
                if edge(before) && edge(after) { return true }
                search = said.index(after: r.lowerBound)
            }
            return false
        }
        if let site = job.apps.first(where: { web($0) && (ConnectSources.apps[$0]?.sites ?? []).contains(where: names) }) { return site }
        if !names(ConnectSources.shownName(first)) {
            let named = (["GitHub", "Zotero"] + ConnectSources.appOrder).filter { $0 != first && names(ConnectSources.shownName($0)) }.sorted { ConnectSources.shownName($0).count > ConnectSources.shownName($1).count }.first
            if let named { return named }
        }
        return first
    }

    func ownStatus(_ app: String) -> (connected: Bool, pending: JSONValue?, error: String?) {
        if app == "Zotero" { return (deps.zotero.status()?.connected ?? false, nil, nil) }
        if app == "GitHub" { return (deps.github.status()?.connected ?? false, nil, nil) }
        return (false, nil, nil)
    }
    func isConnectorApp(_ app: String) -> Bool { ConnectSources.apps[app]?.reach == .connector }
    func connectorConnected(_ app: String) -> Bool { guard let c = deps.connectors, isConnectorApp(app) else { return false }; return (try? c.status(app).connected) ?? false }
    func checkConnectors(_ apps: [String]) async {
        guard let c = deps.connectors else { return }
        for app in apps where isConnectorApp(app) { _ = try? await c.check(app) }
    }

    /// A connector whose server can't serve this account: its website instead, or skipped with a quiet line.
    func connectorFallback(_ s: ConnectSession, _ app: String) -> Bool {
        guard let status = try? deps.connectors?.status(app), status.state == "unavailable" else { return false }
        let info = ConnectSources.apps[app]
        if ConnectSources.fallbackOf(app) != "web" || (info?.sites.isEmpty ?? true) {
            s.leave(app, "its connector doesn’t serve your account")
            skipApp(s, app)
            notice(s, "Couldn't connect to \(ConnectSources.shownName(app)). Skipped.")
            return true
        }
        let site = ExtraTool(name: ConnectSources.shownName(app), website: info?.start ?? "", sites: info?.sites ?? [])
        logAction(s, nil, "\(ConnectSources.shownName(app)) through its website: its connector doesn't serve your account")
        let d = s.choices.direct
        Task { @MainActor in
            let job = await toolJob(s, site) { how, _ in
                let base = d.map { ImportFlow.importPlan(app: ImportFlow.sites, mode: $0.mode, projects: $0.flowProjects, roles: $0.roles, work: $0.work, period: ConnectSources.periodName(s.choices.days)) + "\n\n" } ?? ""
                return "\(base)This is \(ConnectSources.shownName(app)), read through its website because its connector doesn't serve their account. \(how), and bring in its notes about \(d != nil ? "these projects" : "the project in <project>") as notes (add_note)."
            }
            dispatch(s, kind: job.kind, source: job.source, apps: job.apps, label: job.label, plan: job.plan, extra: job.extra, route: job.route, keyExtra: job.keyExtra)
        }
        return true
    }

    func stepSignedIn(_ need: ConnectNeed) -> Bool {
        if Self.signinApps.contains(need.app) { return ownStatus(need.app).connected }
        if need.kind == "connector" { return connectorConnected(need.app) }
        return false
    }

    /// While a step Engelbart can check is open, its sign-in is looked at every second (2026-10-14, the Zotero beta report).
    func watchStep(_ s: ConnectSession, _ need: ConnectNeed) {
        if need.watch != nil || need.closed || need.own != nil { return }
        if !Self.signinApps.contains(need.app) && !(need.kind == "connector" && isConnectorApp(need.app)) { return }
        let ms = deps.stepPollMs ?? Self.stepPollMs
        need.watch = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(ms * 1_000_000))
                if need.closed || s.stopped || s.suspended { need.watch = nil; return }
                if stepSignedIn(need) {
                    need.watch = nil; need.busy = false
                    logAction(s, nil, "Signed in to \(ConnectSources.shownName(need.app))", who: "You")
                    closeNeed(s, need, "done")
                    return
                }
            }
        }
    }

    func laterWhy(_ need: ConnectNeed) -> String {
        switch need.kind {
        case "permission": return "you didn’t allow Engelbart to read it"
        case "consent": return "you didn’t allow Engelbart to search and read it"
        case "connector": return "you skipped connecting it"
        case "confirm": return "you skipped it"
        default: return "you skipped signing in"
        }
    }

    /// An agent hands the person a step: one request per app and kind, then waits for it.
    func askPerson(_ s: ConnectSession, _ job: ConnectJob, kind given: String, reason: String) async -> JSONValue {
        var kind = given
        let app = needApp(job, reason)
        let shown = ConnectSources.shownName(app)
        if s.skipped.contains(app) { return ["status": "skipped", "note": .string("The person skipped \(shown) for this run. Do not ask again: finish without it.")] }
        if Self.signinApps.contains(app) {
            kind = "signin"
            if ownStatus(app).connected {
                logAction(s, job, "\(shown) is signed in: trying again")
                return ["status": "done", "note": .string("\(shown) is signed in already\(app == "Zotero" ? " (the Zotero tools wait for its library to finish syncing)" : ""). Try its tools again. Do not call needs_you for \(shown) again.")]
            }
        }
        if kind == "connector" && isConnectorApp(app) && connectorConnected(app) && !job.connectors.contains(app) {
            job.rerun = true
            return ["status": "done", "note": .string("\(shown) is connected now, but this import started without it. Finish now with what you have; Engelbart starts the \(shown) import again with the connection.")]
        }
        if job.route == "browser" && s.choices.browserAgents != nil { return await askInBrowser(s, job, app, kind: kind, reason: reason) }
        if (kind == "signin" || kind == "password") && deps.webSignIn != nil && signsInAtAll(app) && ConnectSources.apps[app]?.reach == .web { return await signInAgain(s, job, app) }
        if (kind == "signin" || kind == "password") && job.apps.isEmpty, let tool = job.extra?.tool, tool.name == app { return await recover(s, job, tool: tool) }
        var need = s.needs.first { !$0.closed && $0.app == app && $0.kind == kind }
        if need == nil {
            let n = ConnectNeed(app: app, kind: kind, reason: reason, at: now())
            n.note = noteFor(app, kind)
            s.needs.append(n)
            logAction(s, job, "Needs you: \(reason)")
            traced(kind: "need", sessionId: s.id, jobId: job.id, text: "Needs the person (\(kind), \(shown)): \(reason)")
            need = n
        }
        if !need!.jobs.contains(job.id) { need!.jobs.append(job.id) }
        watchStep(s, need!)
        return await waitOn(s, job, need!)
    }

    /// A browser agent stopped at a sign-in in the person's own browser: a card whose Open brings that browser forward.
    func askInBrowser(_ s: ConnectSession, _ job: ConnectJob, _ app: String, kind: String, reason: String) async -> JSONValue {
        let ba = s.choices.browserAgents!
        var need = s.needs.first { !$0.closed && $0.app == app && $0.kind == kind && $0.own != nil }
        if need == nil {
            let what = kind == "signin" || kind == "password" ? "Sign in" : kind == "2fa" ? "Enter the code" : kind == "captcha" ? "Answer the check" : "Do it"
            let n = ConnectNeed(app: app, kind: kind, reason: reason, at: now())
            n.note = "\(what) on its tab in \(ba.browserName), then press Done. The agent never types a password."
            n.own = ba.browserName; n.ownId = ba.browserId
            s.needs.append(n)
            logAction(s, job, "Needs you in \(ba.browserName): \(reason)")
            traced(kind: "need", sessionId: s.id, jobId: job.id, text: "Needs the person in \(ba.browserName) (\(kind), \(ConnectSources.shownName(app))): \(reason)")
            need = n
        }
        if !need!.jobs.contains(job.id) { need!.jobs.append(job.id) }
        return await waitOn(s, job, need!)
    }

    /// An agent found `app` signed out partway through: its word checked first; standing → reload; else recover.
    func signInAgain(_ s: ConnectSession, _ job: ConnectJob, _ app: String) async -> JSONValue {
        let group = ConnectSources.signInGroup(app)
        if s.signInsAgain[group] == nil { s.signInsAgain[group] = (nil, 0, []) }
        if recovering(s, app: app) { return await recover(s, job, app: app) }
        let shown = ConnectSources.shownName(app)
        if s.signInsAgain[group]!.stood.contains(job.id) {
            logAction(s, job, "Carried on without \(shown): it still looked signed in")
            emit(s)
            return ["status": "skipped", "note": .string("\(shown) still looks signed in to Engelbart, so the trouble is on its side. Do not ask again: finish without it with what you have, and say so in your answer.")]
        }
        let again = s.signInsAgain[group]!
        if again.checking == nil || (again.checkedAt > 0 && Time.ms() - again.checkedAt > Self.signInAgainSharedMs) {
            let web = deps.webSignIn!
            let t = Task<Bool, Never> { await web.stillSignedIn(app) }
            s.signInsAgain[group] = (t, 0, again.stood)
            Task { @MainActor in _ = await t.value; if s.signInsAgain[group]?.checking == t { s.signInsAgain[group]!.checkedAt = Time.ms() } }
        }
        let stands = await s.signInsAgain[group]!.checking!.value
        if s.skipped.contains(app) { return ["status": "skipped", "note": .string("\(shown) was left out for this run. Do not ask again: finish without it.")] }
        if !stands { return await recover(s, job, app: app) }
        s.signInsAgain[group]!.stood.insert(job.id)
        logAction(s, job, "Still signed in to \(shown): its page or API failed for a moment")
        emit(s)
        return ["status": "done", "note": "Still signed in: the page or its API failed for a moment. Reload and try again, or finish with what you have."]
    }

    // MARK: a sign-in brought back (M5)

    func recoveryOf(app: String? = nil, tool: ExtraTool? = nil) -> (key: String, name: String, app: String?, tool: ExtraTool?) {
        if let app { return ("app:\(ConnectSources.signInGroup(app))", ConnectSources.shownName(app), app, nil) }
        return ("tool:\(tool!.name.lowercased())", tool!.name, nil, tool)
    }
    func recovering(_ s: ConnectSession, app: String? = nil, tool: ExtraTool? = nil) -> Bool {
        guard let r = s.recoveries[recoveryOf(app: app, tool: tool).key] else { return false }
        return r.phase != "ended"
    }
    func leftAlready(_ s: ConnectSession, name: String, app: String?) -> Bool { s.skipped.contains(name) || (app.map { s.skipped.contains($0) } ?? false) }
    func skippedNote(_ name: String) -> JSONValue { ["status": "skipped", "note": .string("\(name) was left out for this run. Do not ask again: finish without it.")] }
    func backNote(_ name: String) -> JSONValue { ["status": "done", "note": .string("The \(name) sign-in works in Engelbart's browser again. Reload the page and carry on.")] }
    static func toolSites(_ tool: ExtraTool) -> [String] { var out: [String] = []; for s in tool.sites + [SessionText.hostOfSite(tool.website)] where !s.isEmpty && !out.contains(s) { out.append(s) }; return out }

    func copyTool(_ tool: ExtraTool) async -> WebSignIn.Copy {
        let domains = Self.toolSites(tool)
        guard let web = deps.webSignIn, !domains.isEmpty else { return WebSignIn.Copy(copied: 0, signedIn: false) }
        return await web.copyFor(name: tool.name, domains: domains, denied: signInDenied)
    }

    /// The quiet part of a recovery: copied again from the chosen profile a few times over half a minute.
    func quietly(_ s: ConnectSession, _ rec: ConnectSession.Recovery) async -> (browser: String, quiet: WebSignIn.Quiet?)? {
        guard s.choices.keychain, let web = deps.webSignIn else { return nil }
        for wait in deps.recoverWaitsMs ?? Self.recoverWaitsMs {
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000)) }
            if s.stopped || leftAlready(s, name: rec.name, app: rec.app) { return nil }
            if let app = rec.app {
                let out = await web.signInQuiet(app, denied: signInDenied, fresh: true)
                if out.signedIn { return (out.browser, out) }
                if !out.refused.isEmpty { if !out.refusedId.isEmpty { signInDenied.add(out.refusedId) }; return nil }
                if out.held || out.needs != nil || out.declined { return nil }
            } else if let tool = rec.tool {
                let out = await copyTool(tool)
                if out.signedIn == true { return (out.browser ?? "", nil) }
                if out.signedIn == nil && out.copied > 0 { return (out.browser ?? "", nil) }
                if let r = out.refused { if let id = out.refusedId { signInDenied.add(id) }; _ = r; return nil }
                if out.needs != nil || out.declined { return nil }
            }
        }
        return nil
    }

    /// A sign-in that doesn't work in Engelbart's browser, brought back (the onboarding beta, 2026-10-16).
    func recover(_ s: ConnectSession, _ job: ConnectJob?, app: String? = nil, tool: ExtraTool? = nil) async -> JSONValue {
        let who = recoveryOf(app: app, tool: tool)
        if leftAlready(s, name: who.name, app: who.app) { return skippedNote(who.name) }
        var rec = s.recoveries[who.key]
        if let r = rec, r.phase == "ended" {
            if job == nil || !r.told.contains(job!.id) { rec = nil }
            else if r.carded { giveUp(s, nil, r); return ["status": "skipped", "note": .string("\(who.name)'s sign-in did not hold, so it is left out for this run. Do not ask again: finish without it and say so.")] }
            else { r.phase = "card" }
        }
        if rec == nil {
            let r = ConnectSession.Recovery(key: who.key, name: who.name, app: who.app, tool: who.tool)
            s.recoveries[who.key] = r
            logAction(s, job, "Bringing back the \(who.name) sign-in")
            r.quiet = Task { @MainActor in
                if let out = await quietly(s, r) {
                    r.phase = "ended"
                    if let a = r.app, let q = out.quiet { let kept = checkedAs(a, q); for other in ConnectSources.sharesSignIn(a) { signInChecked[other] = kept } }
                    logAction(s, job, !out.browser.isEmpty ? "Copied the \(who.name) sign-in again from \(out.browser)" : "The \(who.name) sign-in works again")
                    emit(s)
                } else if r.phase == "quiet" { r.phase = "card" }
            }
            rec = r
        }
        let r = rec!
        if r.phase == "quiet", let q = r.quiet { await q.value }
        if leftAlready(s, name: who.name, app: who.app) { return skippedNote(who.name) }
        if r.phase == "ended" { if let job { r.told.insert(job.id) }; return backNote(who.name) }
        let need = r.need.flatMap { $0.closed ? nil : $0 } ?? askCard(s, r, job)
        guard let job else {
            need.keep = true
            let how = await withCheckedContinuation { (c: CheckedContinuation<String, Never>) in need.onSettled { c.resume(returning: $0) } }
            return how == "done" ? backNote(who.name) : skippedNote(who.name)
        }
        if !need.jobs.contains(job.id) { need.jobs.append(job.id) }
        let result = await waitOn(s, job, need)
        if result["status"]?.string == "done" { r.told.insert(job.id); return backNote(who.name) }
        return result["status"]?.string == "skipped" ? skippedNote(who.name) : result
    }

    /// The card a recovery ends in, once: Sign in inside Engelbart · Skip.
    func askCard(_ s: ConnectSession, _ rec: ConnectSession.Recovery, _ job: ConnectJob?) -> ConnectNeed {
        rec.phase = "card"
        rec.carded = true
        let need = ConnectNeed(app: rec.app ?? rec.name, kind: Self.signinHere, reason: "Sign in to \(rec.name)", at: now())
        need.where = "here"; need.recovery = rec.key; need.jobs = job.map { [$0.id] } ?? []; need.keep = job == nil
        need.doneNote = JS.string(backNote(rec.name)["note"])
        need.onSettled { how in rec.phase = "ended"; if how == "gone" && s.recoveries[rec.key] === rec { s.recoveries[rec.key] = nil } }
        rec.need = need
        s.needs.append(need)
        logAction(s, job, "Needs you: \(need.reason)")
        traced(kind: "need", sessionId: s.id, jobId: job?.id, text: "Needs the person (sign in inside Engelbart, \(rec.name))")
        emit(s)
        return need
    }

    /// A recovery given up on: left out for the run, with one quiet line that stays.
    func giveUp(_ s: ConnectSession, _ need: ConnectNeed?, _ rec: ConnectSession.Recovery?) {
        let name = rec?.name ?? ConnectSources.shownName(need?.app ?? "")
        notice(s, "Couldn't connect to \(name). Skipped.")
        logAction(s, nil, "Couldn't connect to \(name): skipped")
        if let need, !need.closed { closeNeed(s, need, "skip", why: "Engelbart couldn’t connect to it"); return }
        let app = rec.map { $0.app ?? $0.name } ?? need!.app
        s.leave(app, "Engelbart couldn’t connect to it")
        skipApp(s, app)
        emit(s)
    }

    /// An app held at the start whose sign-in didn't come over: brought back.
    func recoverHeld(_ s: ConnectSession, _ app: String) {
        if s.held[app] == nil { s.holdSet(app, source: (s.choices.direct != nil ? ImportFlow.groupOfApp(app) : ConnectSources.sourceOfApp(app)) ?? "notes") }
        Task { @MainActor in
            let answer = await recover(s, nil, app: app)
            if s.stopped || s.held[app] == nil { return }
            if answer["status"]?.string == "done" { releaseHeld(s, app, "done") }
            else { s.leave(app, "not signed in"); skipApp(s, app); releaseHeld(s, app, "skip") }
            emit(s)
        }
    }

    func heldElsewhere(_ s: ConnectSession, _ app: String, _ browserName: String = "") {
        if s.choices.browserAgents != nil { if readElsewhere(s, app, browserName) { releaseHeld(s, app, "done") }; return }
        if deps.signInWindow != nil { recoverHeld(s, app); return }
        _ = readElsewhere(s, app, browserName)
        releaseHeld(s, app, "skip")
    }

    /// "Sign in inside Engelbart" on a recovery's card.
    func signInHere(_ s: ConnectSession, _ found: ConnectNeed) -> JSONValue {
        if found.busy { return snapshot(s) }
        found.busy = true; found.error = ""; found.opened = true
        emit(s)
        Task { @MainActor in await signInHereNow(s, found) }
        return snapshot(s)
    }

    func signInHereNow(_ s: ConnectSession, _ found: ConnectNeed) async {
        let rec = found.recovery.flatMap { s.recoveries[$0] } ?? ConnectSession.Recovery(key: "", name: ConnectSources.shownName(found.app), app: ConnectSources.apps[found.app] != nil ? found.app : nil, tool: nil)
        var status = "closed", failure = ""
        if let window = deps.signInWindow { found.cancel = { window.close() } }
        if let app = rec.app { status = JS.string(await signInWindowOpen(app)["status"]) }
        else if let window = deps.signInWindow, let tool = rec.tool {
            let sites = Self.toolSites(tool)
            status = await window.openSite(name: rec.name, url: tool.website.isEmpty ? (sites.first.map { "https://\($0)" } ?? "") : tool.website, domains: sites)
        } else { status = "failed"; failure = "Couldn't open \(rec.name) inside Engelbart." }
        found.busy = false
        found.cancel = nil
        if found.closed { return }
        var works = status == "signed-in"
        if works, let app = rec.app, let web = deps.webSignIn { works = await web.stillSignedIn(app) }
        if works {
            if let app = rec.app { for other in ConnectSources.sharesSignIn(app) { signInChecked[other] = ["status": "signed-in", "browser": "", "browserId": ""] } }
            logAction(s, nil, "Signed in to \(rec.name) inside Engelbart", who: "You")
            closeNeed(s, found, "done")
            return
        }
        found.tries += 1
        if ["signed-in", "rejected", "refused"].contains(status) || found.tries >= 2 { giveUp(s, found, rec); return }
        found.error = status == "failed" && !failure.isEmpty ? SessionText.line(failure, 200) : "Not signed in to \(rec.name) yet."
        emit(s)
    }

    func waitAgain(_ s: ConnectSession, _ job: ConnectJob) async -> JSONValue {
        guard let need = s.needs.first(where: { !$0.closed && $0.jobs.contains(job.id) }) else { return ["status": "done", "note": "Nothing is waiting on the person any more."] }
        return await waitOn(s, job, need)
    }

    func waitOn(_ s: ConnectSession, _ job: ConnectJob, _ need: ConnectNeed) async -> JSONValue {
        job.status = "waiting"
        emit(s)
        return await withCheckedContinuation { (c: CheckedContinuation<JSONValue, Never>) in
            let once = OnceFlag()
            let timer = Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(Self.needWaitMs * 1_000_000))
                guard once.take() else { return }
                need.waiters[job.id] = nil
                if job.status == "waiting" { job.status = "running" }
                emit(s, soon: true)
                c.resume(returning: ["status": "waiting", "note": "The person has not done it yet. Call wait_for_you again, or go on without it and say so."])
            }
            need.waiters[job.id] = { result in
                guard once.take() else { return }
                timer.cancel()
                if job.status == "waiting" { job.status = "running" }
                c.resume(returning: result)
            }
        }
    }

    /// The person answered a request: done (the agents go on) or skip (they go on without that app).
    func closeNeed(_ s: ConnectSession, _ need: ConnectNeed, _ how: String, why: String = "") {
        if need.closed { return }
        need.closed = true
        need.outcome = how
        need.watch?.cancel(); need.watch = nil
        need.cancel?()
        if how == "skip" && !s.stopped {
            s.leave(need.app, why.isEmpty ? laterWhy(need) : why)
            skipApp(s, need.app, waiting: need.jobs)
            if need.kind == Self.signinHere && ConnectSources.apps[need.app] != nil {
                for other in ConnectSources.sharesSignIn(need.app) where other != need.app && pickedHere(s, other) { s.leave(other, why.isEmpty ? laterWhy(need) : why); skipApp(s, other) }
            }
        }
        need.settle(how)
        if need.held { releaseHeld(s, need.app, how == "skip" ? "skip" : "done") }
        let restart = how == "done" && need.kind == "connector" && isConnectorApp(need.app)
        if restart { for job in s.jobs where need.jobs.contains(job.id) && job.kind == "import" && !job.connectors.contains(need.app) { job.rerun = true } }
        let shown = ConnectSources.shownName(need.app)
        var done: JSONValue = ["status": "done"]
        if restart { done = ["status": "done", "note": .string("\(shown) is connected now, but this import started without it. Finish now with what you have; Engelbart starts the \(shown) import again with the connection.")] }
        else if let n = need.doneNote { done = ["status": "done", "note": .string(n)] }
        for (jobId, resolve) in need.waiters { resolve(how == "skip" ? ["status": "skipped"] : done); deps.browser?.hide(jobId) }
        need.waiters = [:]
        for jobId in need.jobs { deps.browser?.hide(jobId) }
        logAction(s, nil, how == "skip" ? "Skipped: \(need.reason)" : "Done: \(need.reason)", who: "You")
        emit(s)
    }

    /// An app the person skipped, left out for the rest of the run.
    func skipApp(_ s: ConnectSession, _ app: String, waiting: [String] = []) {
        if app.isEmpty || s.skipped.contains(app) { return }
        s.skipped.insert(app)
        for job in s.jobs where !job.apps.isEmpty && job.apps.allSatisfy({ s.skipped.contains($0) }) && !waiting.contains(job.id) {
            if job.status == "queued" { job.status = "stopped"; job.skipped = true; job.ended = now() }
            else if job.status == "running", let c = job.controller { job.skipped = true; c.abort() }
        }
        if let source = ConnectSources.sourceOfApp(app) {
            var note = s.found[source]?[app]?.object ?? [:]
            note["skipped"] = "The person skipped this app for this run: leave it out, and do not offer, ask about or hand it over again."
            s.put(source, app, .object(note), news: true)
        }
    }

    /// Skip on the librarian's last question or button: nothing of it comes in.
    func skipAsked(_ s: ConnectSession) -> String {
        guard let last = lastSaid(s) else { return "" }
        if let app = last.value["authorize"]?["app"]?.string { skipApp(s, app); return app }
        guard let ask = last.value["ask"], let source = ask["source"]?.string, let group = ConnectSources.sourceOf(source) else { return "" }
        let apps = ask["apps"]?.array?.compactMap(\.string) ?? []
        if !apps.isEmpty { apps.forEach { skipApp(s, $0) }; return apps.joined(separator: ", ") }
        skipSource(s, source)
        return group.label
    }

    func skipSource(_ s: ConnectSession, _ source: String) {
        if s.skippedSources.contains(source) { return }
        s.skippedSources.insert(source)
        let text: JSONValue = "The person skipped this source for this run: nothing of it comes in. Do not offer, ask about or dispatch it again."
        s.found[source, default: [:]]["skipped"] = text
        s.newFound = s.newFound ?? [:]
        s.newFound![source, default: [:]]["skipped"] = text
        logAction(s, nil, "Skipped \(ConnectSources.sourceOf(source)?.label ?? source)", who: "You")
    }

    /// A job that ended stops waiting; a request no job waits on any more goes.
    func releaseNeeds(_ s: ConnectSession, _ job: ConnectJob) {
        for need in s.needs where !need.closed && need.jobs.contains(job.id) {
            need.waiters[job.id] = nil
            need.jobs.removeAll { $0 == job.id }
            if need.jobs.isEmpty && !need.keep { need.closed = true; need.watch?.cancel(); need.watch = nil; need.cancel?(); need.settle("gone") }
        }
    }

    /// `app` is signed in in the person's browser, but that sign-in won't work in Engelbart's.
    @discardableResult
    func readElsewhere(_ s: ConnectSession, _ app: String, _ browserName: String = "") -> Bool {
        if s.skipped.contains(app) { return false }
        if let ba = s.choices.browserAgents {
            s.fallback.insert(app)
            logAction(s, nil, "\(ConnectSources.shownName(app)): read in \(ba.browserName), where you're signed in")
            return true
        }
        let b = browserName.isEmpty ? "your browser" : browserName
        s.leave(app, "you're signed in to it in \(b), but it doesn't let Engelbart use that sign-in")
        skipApp(s, app)
        notice(s, "Left out \(ConnectSources.shownName(app)): you're signed in to it in \(b), but it doesn't let Engelbart use that sign-in.")
        logAction(s, nil, "Left out \(ConnectSources.shownName(app)): its sign-in in \(b) doesn't work in Engelbart")
        return false
    }

    /// An app signed out when an Import your context run starts: a card, its import held until signed in.
    func signInCard(_ s: ConnectSession, _ app: String, kind: String = "signin") {
        if s.needs.contains(where: { !$0.closed && $0.app == app && $0.kind == kind }) { return }
        let shown = ConnectSources.shownName(app)
        let reason = kind == "connector" ? "Connect \(shown) so its agent can bring in what pertains to your projects" : "Sign in to \(shown) so its agent can bring in what pertains to your projects"
        let need = ConnectNeed(app: app, kind: kind, reason: reason, at: now())
        need.note = noteFor(app, kind)
        need.held = true
        s.needs.append(need)
        if s.held[app] == nil { s.holdSet(app, source: ImportFlow.groupOfApp(app) ?? ConnectSources.sourceOfApp(app) ?? "other") }
        logAction(s, nil, "Needs you: \(reason)")
        traced(kind: "need", sessionId: s.id, text: "Needs the person (\(kind), \(shown)): \(reason)")
        watchStep(s, need)
    }
}
