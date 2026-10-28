import Foundation
import EngelbartCore
import EngelbartDoc
import EngelbartEditor

// Workspace.jsx "Build" (2026-09-25; docs/superpowers/specs/2026-09-25-build-workflow-design.md): the project's Builds by
// id as main announces them, what each running turn is doing, what each has changed; the footer's Build panel, the
// cards' buttons, Preview / Review / Reject, a Build's run output, and a post-it's quick task.
extension WorkspaceModel {
    static let workingStatuses: Set<String> = ["running", "queued", "setting-up", "accepting"]

    /// The cards' state for the editors.
    public var buildStates: [String: BuildState] {
        builds.mapValues { BuildState(status: $0["status"]?.string ?? "", final: $0["final"]?.bool ?? false) }
    }

    func onBuild(_ task: JSONValue) {
        guard task["projectId"]?.string == projectId, let id = task["id"]?.string else { return }
        builds[id] = task
        // a turn that ended leaves nothing to show as progress
        if !Self.workingStatuses.contains(task["status"]?.string ?? "") { buildProgress[id] = nil }
        changed()
    }

    /// The card shows what it is doing, not the text so far.
    func onBuildProgress(_ p: JSONValue) {
        guard p["projectId"]?.string == projectId, let id = p["id"]?.string, let activity = p["activity"], !activity.isNull else { return }
        var held = buildProgress[id]?.object ?? [:]
        for (k, v) in p.object ?? [:] where !["projectId", "id", "log", "lines"].contains(k) { held[k] = v }
        if p["log"]?.bool == true { held["log"] = .array(Array(((held["log"]?.array ?? []) + [activity]).suffix(80))) }
        buildProgress[id] = .object(held)
        changed()
    }

    func onBuildDiff(_ d: JSONValue) {
        guard d["projectId"]?.string == projectId, let id = d["id"]?.string else { return }
        var held = d.object ?? [:]
        held["projectId"] = nil; held["id"] = nil
        buildDiffs[id] = .object(held)
        changed()
    }

    /// A card drawn before any diff came asks once.
    public func wantBuildDiff(_ id: String) {
        guard !diffAsked.contains(id) else { return }
        diffAsked.insert(id)
        let api = self.api, pid = projectId
        Task { @MainActor [weak self] in
            guard let diff = try? await api.buildReview(pid, id), let self else { return }
            if self.buildDiffs[id] == nil { self.buildDiffs[id] = diff; self.changed() }
        }
    }

    /// The footer's Build: the panel hung from it; a second press closes it.
    public func toggleBuildDialog(anchor: CGRect) { buildDialog = buildDialog == nil ? anchor : nil; changed() }
    public func closeBuildDialog() { buildDialog = nil; changed() }

    /// Send in the panel: the Build starts from what is saved; its line goes at the end of the workspace's document and its
    /// card shows there at once. "Automatically clear workspace" then clears it, as Clear does (2026-09-27).
    public func startBuild(_ input: JSONValue, clear: Bool) async throws {
        await flushAll()
        guard let topic else { throw WorkspaceError("Open a project first") }
        var payload = input.object ?? [:]
        payload["workspaceId"] = .string(topic.id)
        let task = try await api.buildStart(projectId, .object(payload))
        guard let id = task["id"]?.string else { return }
        builds[id] = task
        let key = "ws:\(topic.id)", ref = PaneRef.workspace(topic.id)
        let held: String
        if let d = docs[key] { held = d } else { held = (try? await api.readDoc(projectId, .workspace(workspaceId: topic.id))) ?? "" }
        let body = Rx(#"\n+$"#).replace(held, with: "")
        changeDoc(key, ref, "\(body.isEmpty ? "" : "\(body)\n\n")\(Doc.buildLine(id))\n")
        buildDialog = nil
        changed()
        if clear && conflicts[key] != nil { report("Not cleared: this document was changed in another window. Keep yours or take theirs, then Clear.") }
        else if clear {
            do {
                await flush(key)?.value
                let out = try await api.clearWorkspace(projectId, topic.id)
                docSync.seen(key, out.revision)
                docs[key] = out.text
                changed()
                await reload()
            } catch { report(error) }
        } else if !(input["attach"]?.array ?? []).isEmpty { await reload() } // what was attached is linked: the sidebar shows it
    }

    /// What a card's buttons do. Accept's refusals and a turn's failures are on the card; only a call that could not be
    /// made at all is reported. → false when the call failed (the reply field keeps its text).
    @discardableResult
    public func onBuildAction(_ id: String, _ action: String, text: String = "", interrupt: Bool = false, images: [JSONValue] = [], name: String? = nil) async -> Bool {
        let pid = projectId
        do {
            switch action {
            case "reply": try await api.buildReply(pid, id, text, interrupt: interrupt, images: images)
            case "stop": try await api.buildStop(pid, id)
            case "resume": try await api.buildResume(pid, id)
            case "fix": try await api.buildFix(pid, id)
            case "discard": try await api.buildDiscard(pid, id)
            case "accept": try? await api.buildAccept(pid, id) // refused: the card says why
            case "reject": rejecting = (id, builds[id]?["title"]?.string ?? ""); changed()
            case "runshow": try await api.buildRunShow(pid, id, name ?? "") // its Stage tab or its terminal, again
            case "runstop": try await api.buildRunStop(pid, id)
            case "runstopone": try await api.buildRunStopRunnable(pid, id, name) // an accepted Build's, on what landed
            case "runstopall": try await api.buildRunStopRunnable(pid, id, nil)
            case "review":
                let task = builds[id]
                let title = task?["title"]?.string ?? ""
                // The card's Preview (2026-09-29): what its run step got running opens in the Stage, and that is all it
                // does; the Review dialog opens only when nothing runs, or what runs could not be opened.
                let shown = (task?["runStep"]?["runnables"]?.array ?? []).filter { $0["status"]?.string == "running" && $0["type"]?.string == "ui" }
                if !shown.isEmpty {
                    do {
                        for item in shown.reversed() { try await api.buildRunShow(pid, id, item["name"]?.string ?? "") } // the first ends in front
                        return true
                    } catch { /* stopped meanwhile: the dialog instead */ }
                }
                review = (id, title, nil, "")
                changed()
                do {
                    let got = try await api.buildReview(pid, id)
                    if review?.id == id { review?.review = got; changed() }
                } catch {
                    if review?.id == id { review?.error = Self.message(of: error); changed() }
                }
            default: break
            }
            return true
        } catch {
            report(error)
            return false
        }
    }
    public func closeReview() { review = nil; changed() }
    public func closeReject() { rejecting = nil; changed() }

    /// What a Build's run step got running (main/build/run-step.cjs): a web UI in a Stage tab, a terminal program's session
    /// in the terminal; a closed session goes.
    func onBuildRun(_ event: JSONValue) {
        if event["kind"]?.string == "closed", let sid = event["sessionId"]?.string { ctx.dropTerminal(sid); return }
        guard event["projectId"]?.string == projectId else { return }
        if event["kind"]?.string == "ui", let url = event["url"]?.string { openLink(url, newTab: false) }
        else if event["kind"]?.string == "terminal", let session = event["session"], let id = ctx.adoptTerminal(session, projectId) {
            showRight("terminal")
            showTerminalSession?(id)
        }
    }

    /// A shell in a repository's sandbox (SandboxProgress openTerminal): a tab of this project's terminal pane, shown in front
    /// unless the preview is (`show`).
    func onSandboxTerminal(_ event: JSONValue) {
        guard let session = event["session"], session["id"]?.string != nil, let id = ctx.adoptTerminal(session, projectId) else { return }
        if event["show"]?.bool == true { showRight("terminal") }
        showTerminalSession?(id)
    }

    // MARK: a post-it's Build popup and its quick task (Claude Design "Post-it Quick Task", 2026-09-27)

    func onBuildQuick(_ e: JSONValue) {
        guard active, e["projectId"]?.string == projectId, let postItId = e["postItId"]?.string else { return }
        quickTask = nil
        postItBuild = postItBuild?.postItId == postItId ? nil : (postItId, e["text"]?.string ?? "", Self.anchor(e["button"]))
        changed()
    }

    func onBuildQuickOpen(_ e: JSONValue) {
        guard active, e["projectId"]?.string == projectId, let id = e["id"]?.string else { return }
        postItBuild = nil
        if let task = builds[id], task["kind"]?.string == "build", let wid = task["workspaceId"]?.string, let version = task["version"], !version.isNull {
            quickTask = nil
            Task { @MainActor [weak self] in await self?.goToVersion(wid, file: version["file"]?.string ?? "", title: version["title"]?.string ?? "") }
        } else {
            quickTask = quickTask?.id == id ? nil : (id, e["postItId"]?.string, Self.anchor(e["button"]))
        }
        changed()
    }

    static func anchor(_ rect: JSONValue?) -> CGRect? {
        guard let r = rect, let x = r["x"]?.double, let y = r["y"]?.double, x.isFinite, y.isFinite else { return nil }
        return CGRect(x: x, y: y, width: r["width"]?.double ?? 0, height: r["height"]?.double ?? 0)
    }

    /// The popup sends it as a quick task.
    public func startQuick(_ input: JSONValue) async throws {
        guard let quick = postItBuild else { return }
        var payload = input.object ?? [:]
        payload["kind"] = "quick"; payload["postItId"] = .string(quick.postItId); payload["text"] = .string(quick.text)
        let task = try await api.buildStart(projectId, .object(payload))
        if let id = task["id"]?.string { builds[id] = task }
        postItBuild = nil
        changed()
    }

    /// A quick task added to a workspace: a Build of the workspace picked there, on the model picked there.
    public func promoteQuick(_ id: String, workspaceId: String, choice: JSONValue?) async throws -> JSONValue {
        let task = try await api.buildPromote(projectId, id, workspaceId, choice: choice)
        if let tid = task["id"]?.string { builds[tid] = task; changed() }
        return task
    }
    public func goToTask(_ task: JSONValue) {
        guard let version = task["version"], !version.isNull, let wid = task["workspaceId"]?.string else { return }
        Task { @MainActor [weak self] in await self?.goToVersion(wid, file: version["file"]?.string ?? "", title: version["title"]?.string ?? "") }
    }

    /// A post-it added to a workspace (2026-09-27: "it should take me to that workspace"): that workspace, with the
    /// archived version the post-it was put in as open in the middle.
    public func goToVersion(_ workspaceId: String, file: String, title: String) async {
        await reload()
        guard !file.isEmpty else { return }
        selectTopic(workspaceId)
        openTab("\(WorkspaceTabs.archivePrefix)\(file)", title: title)
    }
}
