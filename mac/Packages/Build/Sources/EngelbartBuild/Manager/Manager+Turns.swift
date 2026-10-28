import Foundation
import EngelbartCore

/// What `start` is given (ipc.cjs build-start, validated by BuildService).
public struct BuildStart: Sendable {
    public var kind = "build"
    public var workspaceId: String?
    public var postItId: String?
    /// A post-it's text: a quick task's, or a post-it added to a workspace (a Build of it whose task is the post-it).
    public var text: String?
    /// `@bart --build <request>` (2026-10-02).
    public var fromLine = false
    /// Bart's router record (`route-…`), when Bart handed the line to Build.
    public var routedFrom: String?
    /// The line it came from (the Agent Viewer): { ref, line, text }.
    public var place: JSONValue?
    public var provider: String?
    public var model: String?
    public var effort: String?
    public var attach: [String] = []
    public var target: JSONValue?
    public init(kind: String = "build", workspaceId: String? = nil, postItId: String? = nil, text: String? = nil, fromLine: Bool = false,
                routedFrom: String? = nil, place: JSONValue? = nil, provider: String? = nil, model: String? = nil, effort: String? = nil,
                attach: [String] = [], target: JSONValue? = nil) {
        self.kind = kind; self.workspaceId = workspaceId; self.postItId = postItId; self.text = text; self.fromLine = fromLine
        self.routedFrom = routedFrom; self.place = place; self.provider = provider; self.model = model; self.effort = effort
        self.attach = attach; self.target = target
    }
}

/// A reply's pasted image as the card sends it ([Attachment n] → a library image).
public struct PastedImage: Sendable, Equatable {
    public var n: Int
    public var id: String
    public init(n: Int, id: String) { self.n = n; self.id = id }
}

extension BuildManager {
    static let fromEngelbart = { (text: String) in "<from_engelbart>\n\(text)\n</from_engelbart>" }

    /// A post-it's title: its first line with words in it, without its markdown.
    static func postItTitle(_ text: String?) -> String {
        let first = (text ?? "").components(separatedBy: "\n").map {
            $0.replacingOccurrences(of: #"^(#{1,3} |- \[[ xX]?\] |[-*] |> )"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        }.first { !$0.isEmpty }
        return String((first ?? "Quick task").prefix(80))
    }

    /// A quick task's post-it, from its record or (a record from before 2026-09-27) from its frozen context.
    static func postItOf(_ task: TaskRecord, _ context: String?) -> String {
        if let p = task.str("postIt") { return p }
        if let c = context, let r = c.range(of: #"<post-it>\n([\s\S]*?)\n</post-it>"#, options: .regularExpression) {
            return String(c[r]).replacingOccurrences(of: "<post-it>\n", with: "").replacingOccurrences(of: "\n</post-it>", with: "")
        }
        return task.str("title") ?? ""
    }

    /// A Build's `place` (the Agent Viewer): { projectId, ref, line, text } for one from a line; no line for the panel's
    /// or a post-it's.
    static func placeOfTask(_ projectId: String, _ workspaceId: String?, _ from: JSONValue?) -> JSONValue {
        let held = from?.object ?? [:]
        var ref: JSONValue = .null
        if let r = held["ref"], ["workspace", "note"].contains(r["kind"]?.string ?? "") { ref = r }
        else if let workspaceId { ref = ["kind": "workspace", "workspaceId": .string(workspaceId)] }
        let line: JSONValue = held["line"]?.int.map { $0 >= 0 ? .number(Double($0)) : .null } ?? .null
        let text: JSONValue = held["text"]?.string.map { .string(String($0.prefix(8000))) } ?? .null
        return ["projectId": .string(projectId), "ref": ref, "line": line, "text": text]
    }

    /// What the card says when a turn's agent got past what a Build may do. → lines, none when it kept to them.
    static func guardNotes(_ putBack: [LibraryKeep.PutBack], _ holding: (branch: Bool, commits: Bool)?) -> [String] {
        func names(_ list: [LibraryKeep.PutBack]) -> String {
            let shown = list.prefix(5).map { "“\($0.name)”" }
            return shown.joined(separator: ", ") + (list.count > shown.count ? " and \(list.count - shown.count) more" : "")
        }
        var out: [String] = []
        let deleted = putBack.filter { $0.how == "deleted" }, changed = putBack.filter { $0.how == "changed" }
        if !deleted.isEmpty { out.append("The agent deleted \(names(deleted)) from the library. Engelbart put \(deleted.count == 1 ? "it" : "them") back.") }
        if !changed.isEmpty { out.append("The agent changed \(names(changed)). Engelbart put \(changed.count == 1 ? "it" : "them") back as \(changed.count == 1 ? "it was" : "they were"): papers are only read in a Build.") }
        if holding?.branch == true { out.append("The agent left the Build's branch. Engelbart put its copy back on it, with the files as the agent left them.") }
        if holding?.commits == true { out.append("The agent moved the Build's branch (commits of its own, or a reset). Engelbart put the branch back where the turn started; what the agent did is in this turn's checkpoint.") }
        return out
    }

    /// A reply's pasted images → those that are this project's images on disk (path). The rest are dropped.
    func pastedImages(_ projectId: String, _ images: [PastedImage]) async throws -> [(n: Int, id: String, path: String)] {
        let project = try projectOf(projectId)
        var out: [(Int, String, String)] = []
        for image in images.prefix(BuildManager.maxAttach) where image.n >= 1 && BuildManager.isUUID(image.id) {
            guard let row = await host.libraryRow(image.id), row.type == "image", let path = row.path else { continue }
            let full = NodePath.resolve(path)
            guard full.hasPrefix(project.dir + "/"), FS.exists(full) else { continue }
            out.append((image.n, row.id, full))
        }
        return out
    }

    static func imageRefs(_ images: [(n: Int, id: String, path: String)]) -> [JSONValue] { images.map { ["n": .number(Double($0.n)), "id": .string($0.id)] } }

    /// The workspace a Build belongs to, by name (the Agent map's record); nil when it has none or it is gone.
    func workspaceNameOf(_ projectId: String, _ task: TaskRecord) -> String? {
        guard let wid = task.str("workspaceId") else { return nil }
        return try? host.workspace(projectId, wid).name
    }

    // MARK: start

    public func start(_ projectId: String, _ input: BuildStart) async throws -> JSONValue {
        reconcile()
        let kind = input.kind == "quick" ? "quick" : "build"
        // A post-it's text: a quick task's, or a post-it added to a workspace.
        let postIt: String? = kind == "quick" || input.text != nil ? (input.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) : nil
        if postIt == "" { throw BuildError("The sticky is empty.") }
        let wanted: JSONValue? = postIt == nil ? input.target : ["kind": "default"] // a post-it's Build: always the default repo
        // A request typed after --build on an @bart line: a post-it's Build in every way but three (not archived, not a
        // recent workspace, given as <request> without the workspace's history).
        let fromLine = kind == "build" && postIt != nil && input.fromLine
        var pre = try await preflight(projectId, wanted)
        // A library repository that is not on this Mac is cloned into repos/<name> first, before anything else.
        if pre["ok"]?.bool != true && pre["canClone"]?.bool == true { pre = try await cloneRepository(projectId, wanted) }
        if pre["ok"]?.bool == true && (pre["create"]?.bool == true || pre["init"]?.bool == true), let dir = pre["directory"]?.string {
            if pre["create"]?.bool == true { try await makeDefault(dir) }
            else { let git = self.git; _ = try await serial(dir) { try await git.initRepository(dir) } }
            pre = try await preflight(projectId, wanted)
        }
        if pre["ok"]?.bool != true { throw BuildError(pre["problems"]?[0]?["message"]?.string ?? "This folder cannot take a Build.") }
        let directory = pre["directory"]?.string ?? ""
        let top = pre["top"]?.string ?? directory
        if pre["target"]?["kind"]?.string == "default" { try await keepDefault(projectId, directory) } // a rename never moves it
        let project = try projectOf(projectId)
        var workspaceId: String?
        var title: String
        if kind == "build" {
            let workspace = try host.workspace(projectId, input.workspaceId)
            workspaceId = workspace.id
            title = postIt != nil ? BuildManager.postItTitle(postIt) : workspace.name
        } else {
            title = BuildManager.postItTitle(postIt)
        }
        let choice = config.readModels().resolve(provider: input.provider, model: input.model, effort: input.effort)
        let at = try await git.head(top)
        guard let baseBranch = at.branch else { throw BuildError("The code folder is not on a branch.") }
        let git = self.git
        let id = try await TaskStore.freeId(project) { await git.branchExists(top, "engelbart/\($0)") }
        let worktree = NodePath.join(host.dataRoot, "worktrees", project.slug, id)
        let inside = NodePath.relative(top, directory)
        var attach: [String] = []
        for value in input.attach where BuildManager.isUUID(value) && !attach.contains(value) { attach.append(value) }
        attach = Array(attach.prefix(BuildManager.maxAttach))
        let dirty = pre["dirty"]?.int ?? 0
        let targetName = pre["target"]?["name"]?.string ?? ""
        var task: TaskRecord = [
            "id": .string(id), "kind": .string(kind), "projectId": .string(projectId), "workspaceId": workspaceId.map(JSONValue.string) ?? .null,
            "postItId": postIt != nil ? input.postItId.map(JSONValue.string) ?? .null : .null, "postIt": postIt.map(JSONValue.string) ?? .null,
            "version": .null, "title": .string(title), "sessionId": .null,
            "target": pre["target"] ?? .null, "source": .string(directory),
            "repo": .string(top), "worktree": .string(worktree),
            "cwd": .string(!inside.isEmpty && !inside.hasPrefix("..") ? NodePath.join(worktree, inside) : worktree),
            "branch": .string("engelbart/\(id)"), "baseBranch": .string(baseBranch), "baseSha": .string(at.sha),
            "status": "setting-up", "question": .null, "error": .null, "queued": .null, "turn": 0, "checkpoints": [],
            "messages": [say("engelbart", "Started on \(choice.modelName) \(choice.effort) in \(targetName), from \(baseBranch) at \(at.sha.prefix(7))\(dirty > 0 ? "; \(dirty) uncommitted \(dirty == 1 ? "file" : "files") left out" : "").")],
            "attach": .array(attach.map(JSONValue.string)), "archive": .null, "checks": .null, "conflict": .null, "accepted": .null,
            "created": .string(Time.iso(now())), "finished": .null,
        ]
        if fromLine { task["fromLine"] = true }
        if let routed = input.routedFrom, routed.range(of: #"^route-[\w-]{1,72}$"#, options: .regularExpression) != nil { task["routedFrom"] = .string(routed) }
        for (k, v) in choice.record { task[k] = v }
        // Where it came from (2026-10-12, the Agent Viewer): the line a Build from a line was typed on, else its workspace.
        task["place"] = BuildManager.placeOfTask(projectId, workspaceId, fromLine ? input.place : nil)
        let frozen = try await BuildContext.freeze(host: host, projectId: projectId, task: task, workspaceId: workspaceId, attach: attach, postIt: postIt, fromLine: fromLine)
        task["archive"] = frozen.archive.map(JSONValue.string) ?? .null
        // A post-it added to a workspace is put in as an archived version of it, after the one it is given as history.
        if let workspaceId, let postIt, !fromLine { task["version"] = try await host.importTask(projectId, workspaceId, text: postIt, buildId: id) }
        try TaskStore.writeContext(project, id, frozen.text)
        let saved = try TaskStore.writeTask(project, task, now: now())
        if let workspaceId {
            try host.addWorkspaceBuild(projectId, workspaceId, id)
            if !attach.isEmpty { try await host.linkToWorkspace(projectId, workspaceId, attach) } // what was attached shows on the sidebar
            if postIt != nil && !fromLine { track { host.recordEdit(projectId, workspaceId) } } // ⌘J's recent workspaces
        }
        emit(saved)
        Task { await self.prepare(projectId, id) } // its project deleted meanwhile: the record went with it
        return TaskStore.publicTask(saved)
    }

    /// The worktree and its setup, then the first turn. A Build discarded meanwhile is cleaned up instead.
    func prepare(_ projectId: String, _ id: String) async {
        guard let project = try? projectOf(projectId), var task = TaskStore.readTask(project, id) else { return }
        do {
            let repo = task.str("repo") ?? "", worktree = task.str("worktree") ?? "", branch = task.str("branch") ?? "", base = task.str("baseSha") ?? ""
            if !FS.exists(worktree) { let git = self.git; _ = try await serial(repo) { try await git.addWorktree(repo, worktree, branch, base) } }
            try await setupWorktree(project, task)
        } catch {
            _ = try? save(projectId, id) { held in
                ["status": "failed", "error": .string("The Build's copy could not be made: \(error.text)"),
                 "messages": .array(held.arr("messages") + [self.say("engelbart", "The Build's copy could not be made: \(error.text)")])]
            }
            return
        }
        guard let after = TaskStore.readTask(project, id) else { return }
        task = after
        if TaskStore.final.contains(task.str("status") ?? "") { await cleanUp(task); return }
        if halted.contains(id) { return }
        await runTurn(projectId, id, message: TaskStore.readContext(project, id) ?? "", fresh: true)
    }

    /// B8: ignored files a checkout lacks. `project.json → build.setup` replaces all of it when set.
    func setupWorktree(_ project: BuildProject, _ task: TaskRecord) async throws {
        let own = Files.readJSON(URL(fileURLWithPath: NodePath.join(project.dir, "project.json")))?.object ?? [:]
        let custom = own["build"]?["setup"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
        let repo = task.str("repo") ?? "", worktree = task.str("worktree") ?? "", cwd = task.str("cwd") ?? worktree
        let source = task.str("source") ?? project.directory ?? repo // a record from before 2026-09-29 has none
        for dir in Array(Set([repo, source])).sorted() {
            let target = NodePath.join(worktree, NodePath.relative(repo, dir))
            let names = (FS.list(dir) ?? []).filter { $0.range(of: #"^\.env(\..+)?$"#, options: .regularExpression) != nil }
            for name in names {
                let to = NodePath.join(target, name), from = NodePath.join(dir, name)
                if !FS.exists(to) && FS.isFile(from) { try? FileManager.default.copyItem(atPath: from, toPath: to) } // one file less
            }
        }
        if let custom, !custom.isEmpty {
            let out = await config.runShell(custom, cwd, ["ENGELBART_SOURCE_DIR": source])
            if !out.ok {
                let last = out.output.components(separatedBy: "\n").filter { !$0.isEmpty }.suffix(3).joined(separator: " ")
                throw BuildError("the setup command failed: \(last)")
            }
            return
        }
        if custom == "" { return }
        let modules = NodePath.join(source, "node_modules"), theirs = NodePath.join(cwd, "node_modules")
        if FS.exists(modules) && !FS.exists(theirs) {
            if let copy = config.copyTree { try await copy(modules, theirs) } else { try await BuildManager.cloneTree(modules, theirs) }
        }
    }

    /// A copy-on-write clone (APFS `cp -cR`): instant, and the Build's installs never reach the person's copy.
    static func cloneTree(_ from: String, _ to: String) async throws {
        let out = await Exec.run("/bin/cp", ["-cR", from, to], environment: ProcessInfo.processInfo.environment, timeout: CheckShell.shellMs)
        if !out.ok { throw BuildError("node_modules could not be copied (\(BuildGit.firstLine(out.stderr.isEmpty ? (out.spawnError ?? "cp failed") : out.stderr)))") }
    }

    // MARK: turns

    func runTurn(_ projectId: String, _ id: String, message: String, fresh: Bool = false) async {
        if halted.contains(id) { return }
        guard let project = try? projectOf(projectId), var task = TaskStore.readTask(project, id),
              !TaskStore.final.contains(task.str("status") ?? ""), live[id] == nil else { return }
        let pool = task.str("kind") == "quick" ? "quick" : "build"
        let entry = Live()
        live[id] = entry
        var hasSlot = false
        var bridge: ToolBridge?
        var keeping: LibraryKeep?
        var record: String?
        defer { } // the cleanup below runs on every path (the JS finally)
        await haltRunStep(id) // a run step still working ends (its changes a checkpoint) before the worktree is the agent's again
        if active[pool, default: 0] >= config.limits[pool, default: 1] { _ = try? save(projectId, id, ["status": "queued"]) }
        hasSlot = await slot(pool, entry.signal)
        if !hasSlot {
            _ = try? save(projectId, id) { held in
                ["status": .string(entry.stopping == "quit" ? "interrupted" : "stopped"), "messages": .array(held.arr("messages") + [self.say("engelbart", "Stopped before it started.")])]
            }
            finishTurn(id, entry, pool: pool, hadSlot: false)
            return
        }
        let worktree = task.str("worktree") ?? "", branch = task.str("branch") ?? ""
        // What the agent may reach (Policy), with the library kept aside while it works (Keep), where its branch stands
        // and Engelbart's tools for it. Made before the card says it runs, so a reply or Stop reaches the agent from then.
        let keepDir = NodePath.join(config.keepDir, id)
        let basePolicy = BuildPolicy.make(projectDir: project.dir, dataRoot: host.dataRoot)
        keeping = try? await LibraryKeep.keep(host: host, dir: keepDir, kept: basePolicy.kept)
        let started = try? await git.head(worktree)
        let startedMerging = await git.merging(worktree)
        let changed = config.libraryChanged
        bridge = try? await ToolBridge.open(EngelbartTools.make(host: host, projectId: projectId, task: task, onAdded: { _ in changed() }))
        let policy = BuildPolicy.make(projectDir: project.dir, dataRoot: host.dataRoot, papers: keeping?.papers ?? [], gitDir: GitGuard.commonDir(worktree))
        guard let saved = try? save(projectId, id, { held in ["status": "running", "error": .null, "question": .null, "turn": .number(Double(held.int("turn") + 1))] }) else {
            if let bridge { await bridge.close() }
            if let keeping { _ = await keeping.restore() }
            finishTurn(id, entry, pool: pool, hadSlot: true)
            return
        }
        task = saved
        let host = self.host
        track { host.agentStarted(["id": .string(id), "kind": "build", "projectId": .string(projectId), "workspaceId": task["workspaceId"] ?? .null,
                                   "doc": task.str("workspaceId").map { ["kind": "workspace", "workspaceId": .string($0)] } ?? .null]) }
        let notify = config.notify
        let feed = ActivityFeed { progress in
            var p = progress.object ?? [:]
            p["projectId"] = .string(projectId); p["id"] = .string(id)
            notify("engelbart:build-progress", .object(p))
        }
        let diffs = DiffWatch(delay: config.diffDelay) { [self] in await self.sendDiff(projectId, task, running: true) }
        let quick = task.str("kind") == "quick"
        let system = BuildPrompt.load(dataRoot: host.dataRoot, quick: quick)
        let provider = task.str("provider") ?? "anthropic"
        let agent = ToolOf.agent(provider)
        let turnNumber = task.int("turn")
        if config.runLog != nil {
            let r = "\(id):\(turnNumber)"
            record = r
            var start: [String: JSONValue] = ["id": .string(r), "agent": "build", "kind": .string(quick ? "quick" : "build"), "buildId": .string(id), "title": task["title"] ?? .null,
                                              "turn": .number(Double(turnNumber)), "provider": .string(provider), "projectId": .string(projectId), "projectName": .string(project.name),
                                              "workspaceName": workspaceNameOf(projectId, task).map(JSONValue.string) ?? .null, "question": task["title"] ?? .null, "system": .string(system),
                                              // The first turn: context.md, block by block; a later one: what was sent.
                                              "context": fresh ? BuildContext.partsJSON(message) : ["reply": .string(message)]]
            if turnNumber == 1, let place = task["place"], !place.isNull { start["place"] = place }
            logged { $0.start(.object(start)) }
        }
        let runner = config.runner, tools = config.tools, signal = entry.signal
        let timeout = config.turnTime[pool] ?? 3600
        var agentTask = task
        agentTask["worktree"] = task["cwd"] ?? task["worktree"]
        let modelName = task.str("modelName") ?? task.str("modelId") ?? ""
        let effort = task.str("effort") ?? ""
        let runLog = config.runLog
        let connection = bridge?.connection
        let once: (String?, String) async throws -> TurnOutput = { session, text in
            feed.reset()
            // Each step, and whatever the model starts after one, reads the diff again.
            let onUpdate: (ActivityUpdate?) -> Void = { update in
                feed.take(update)
                if let u = update, u.activity != nil || u.log || u.textStart { diffs.poke() }
            }
            let onEvent: ((JSONValue) -> Void)? = record.map { r in { event in runLog?.event(r, event) } }
            if let r = record { runLog?.step(r, ["model": .string(task.str("modelId") ?? modelName), "name": .string(modelName), "effort": .string(effort), "input": .string(text)]) }
            // Stopped (or cut short for a reply) before the agent started: the agent never starts.
            let call: @Sendable () async throws -> TurnOutput = {
                if signal.isAborted { throw TurnError("stopped", "Stopped.", session: session) }
                return try await runner.turn(TurnInput(task: agentTask, message: text, session: session, system: system, policy: policy, engelbart: connection,
                                                       signal: signal, timeout: timeout, onUpdate: onUpdate, onEvent: onEvent))
            }
            if let tools { return try await tools.use(agent, call) }
            return try await call()
        }
        var out: TurnOutput?
        var failure: Error?
        do {
            if let tools { try await tools.ensure(agent) }
            let sessionId = task.str("sessionId")
            do {
                // No session to go on with (the first turn was cut short before one was named): everything again.
                if !fresh && sessionId == nil { out = try await once(nil, BuildContext.freshMessage(TaskStore.readContext(project, id), task.arr("messages"), message)) }
                else { out = try await once(fresh ? nil : sessionId, message) }
            } catch {
                if (error as? TurnError)?.kind == "stopped" || fresh || sessionId == nil { throw error }
                // A session that will not resume (its file is gone, the CLI changed): everything again, and what was said.
                out = try await once(nil, BuildContext.freshMessage(TaskStore.readContext(project, id), task.arr("messages"), message))
            }
        } catch {
            failure = error
        }
        feed.end()
        let diffsEnded = diffs.end()
        if let b = bridge { await b.close() }
        bridge = nil
        // The library as it was, and the worktree on its branch, before the checkpoint takes what the agent left.
        let putBack = await keeping?.restore() ?? []
        keeping = nil
        var holding: (branch: Bool, commits: Bool)?
        if let started, started.branch == branch { holding = try? await git.holdBranch(worktree, branch, started.sha, merging: startedMerging) }
        let guarded = BuildManager.guardNotes(putBack, holding).map { say("engelbart", $0) }
        var sha: String?
        var kept: String?
        // A turn that was resolving a conflict and did not finish leaves no half-merge behind.
        var unresolved = false
        if failure != nil { unresolved = await git.merging(worktree) }
        if unresolved { await git.abortMerge(worktree) }
        else {
            do { sha = try await git.concludeMerge(worktree, "Build \(task.str("title") ?? ""): turn \(turnNumber)", await git.identity(task.str("repo") ?? worktree)) }
            catch { kept = error.text }
        }
        let stopping = entry.stopping
        let failureKind = (failure as? TurnError)?.kind
        let failureSession = (failure as? TurnError)?.session
        let at = Time.iso(now())
        if let next = try? save(projectId, id, { held in
            var next: TaskRecord = [
                "sessionId": out?.session.map(JSONValue.string) ?? failureSession.map(JSONValue.string) ?? held["sessionId"] ?? .null,
                "checkpoints": .array(held.arr("checkpoints") + (sha.map { [["sha": .string($0), "turn": .number(Double(held.int("turn"))), "at": .string(at)]] } ?? [])),
            ]
            let notes = guarded + (kept.map { [self.say("engelbart", "The turn's work could not be saved as a checkpoint: \($0)")] } ?? [])
            let messages = held.arr("messages")
            if unresolved {
                next["status"] = .string(stopping == "quit" ? "interrupted" : "conflict")
                next["messages"] = .array(messages + guarded + [self.say("engelbart", "\(failureKind == "stopped" ? "Stopped." : failure!.text) The conflict was left as it was before.")])
            } else if failureKind == "stopped" && stopping == "reply" && held.truthy("queued") {
                next["status"] = "running" // cut short for the reply, which goes on at once in the same session: nothing to say
                next["messages"] = .array(messages + notes)
            } else if failureKind == "stopped" {
                next["status"] = .string(stopping == "quit" ? "interrupted" : "stopped")
                next["messages"] = .array(messages + notes + [self.say("engelbart", stopping == "quit" ? "Engelbart closed while this turn was working. What it had done is saved." : "Stopped. What it had done is saved.")])
            } else if let failure {
                next["status"] = "failed"
                next["error"] = .string(failure.text)
                next["messages"] = .array(messages + notes + [self.say("engelbart", failure.text)])
            } else {
                let end = BuildPrompt.readEnding(out?.text ?? "", quick: held.str("kind") == "quick")
                let said = !end.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || end.ending == "done"
                next["messages"] = .array(messages + notes + (said ? [self.say("agent", end.text.isEmpty ? (out?.text ?? "") : end.text)] : []))
                next["status"] = .string(end.ending == "needs-you" ? "needs-you" : end.ending == "escalated" ? "escalated" : "review")
                next["question"] = end.ending == "needs-you" ? end.question.map(JSONValue.string) ?? .null : .null
                next["escalation"] = end.ending == "escalated" ? (end.why ?? end.question).map(JSONValue.string) ?? .null : .null
            }
            return next
        }) { task = next }
        track { host.agentFinished(id) }
        if let r = record {
            if let out { logged { $0.output(r, ["raw": .string(out.text)]) } }
            let status = task.str("status") ?? ""
            let ending: JSONValue = ["needs-you", "escalated", "review", "conflict"].contains(status) ? .string(status) : .null
            logged { $0.finish(r, ["status": .string(failure == nil ? "done" : failureKind == "stopped" ? "stopped" : "failed"), "written": .null,
                                   "error": failure.map { .string($0.text) } ?? .null, "ending": ending]) }
        }
        let final = task
        Task { await diffsEnded.value; await self.sendDiff(projectId, final, running: false) }
        finishTurn(id, entry, pool: pool, hadSlot: true)
        await afterTurn(projectId, id)
    }

    func finishTurn(_ id: String, _ entry: Live, pool: String, hadSlot: Bool) {
        if hadSlot { release(pool) }
        if live[id] === entry { live[id] = nil }
        settle(entry)
    }

    func afterTurn(_ projectId: String, _ id: String) async {
        if quitting || halted.contains(id) { return }
        guard let project = try? projectOf(projectId), let after = TaskStore.readTask(project, id), !TaskStore.final.contains(after.str("status") ?? "") else { return }
        if let text = after.str("queued"), !text.isEmpty {
            let images = after.arr("queuedImages")
            _ = try? save(projectId, id) { held in ["queued": .null, "queuedImages": .null, "messages": .array(held.arr("messages") + [self.say("you", text, images.map { ["n": $0["n"] ?? .null, "id": $0["id"] ?? .null] })])] }
            let withPaths = images.compactMap { i -> (n: Int, path: String)? in guard let n = i["n"]?.int, let p = i["path"]?.string else { return nil }; return (n, p) }
            Task { await self.runTurn(projectId, id, message: BuildContext.replyMessage(text, images: withPaths)) }
            return
        }
        // An Accept that sent its refusal to the agent runs again once the agent is done; a turn that ended any other way
        // leaves it to the person.
        if let landing = after.obj("landing") {
            if after.str("status") == "review" { let attempt = landing["attempt"]?.int ?? 0; Task { _ = try? await self.accept(projectId, id, attempt: attempt) } }
            else { _ = try? save(projectId, id, ["landing": .null]) }
            return
        }
        // A quick task that finished cleanly lands by itself (B23); a Build that finished a turn gets its run step.
        if after.str("kind") == "quick" && after.str("status") == "review" { Task { _ = try? await self.accept(projectId, id, auto: true) } }
        else if after.str("kind") == "build" && after.str("status") == "review" { startRunStep(projectId, id) }
    }

    // MARK: reply, stop, resume

    /// The person's reply: the next turn now, or after the one running. With `interrupt` (the card's send, 2026-09-27) a
    /// turn that is running is cut short, its work saved, and the reply goes on in the same session.
    public func reply(_ projectId: String, _ id: String, _ text: String, interrupt: Bool = false, images pasted: [PastedImage] = []) async throws -> JSONValue {
        reconcile()
        halted.remove(id)
        let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let task = try read(projectId, id)
        if said.isEmpty { return TaskStore.publicTask(task) }
        let status = task.str("status") ?? ""
        if TaskStore.final.contains(status) { throw BuildError("This Build is closed.") }
        if status == "accepting" { throw BuildError("It is being accepted; reply once that is done.") }
        // only the images the reply still names (an [Attachment n] deleted from the text is not sent)
        let images = try await pastedImages(projectId, pasted).filter { said.contains("[Attachment \($0.n)]") }
        let stored: [JSONValue] = images.map { ["n": .number(Double($0.n)), "id": .string($0.id), "path": .string($0.path)] }
        // The person saying something takes over from an Accept that was fixing its refusal by itself.
        if live[id] != nil || status == "setting-up" {
            let next = try save(projectId, id) { held in
                ["landing": .null, "queued": .string(held.str("queued").flatMap { $0.isEmpty ? nil : "\($0)\n\n\(said)" } ?? said),
                 "queuedImages": .array(held.arr("queuedImages") + stored)]
            }
            if interrupt && status == "running" { stop(projectId, id, why: "reply") }
            return TaskStore.publicTask(next)
        }
        if !FS.exists(task.str("worktree") ?? "") { throw BuildError("This Build's copy is gone; discard it.") }
        let next = try save(projectId, id) { held in
            ["landing": .null, "queued": .null, "queuedImages": .null, "error": .null, "messages": .array(held.arr("messages") + [self.say("you", said, BuildManager.imageRefs(images))])]
        }
        Task { await self.runTurn(projectId, id, message: BuildContext.replyMessage(said, images: images.map { ($0.n, $0.path) })) }
        return TaskStore.publicTask(next)
    }

    @discardableResult
    public func stop(_ projectId: String, _ id: String, why: String = "stop") -> Bool {
        guard let entry = live[id] else { return false }
        entry.stopping = entry.stopping ?? why
        entry.signal.abort()
        return true
    }

    /// An interrupted, stopped or failed Build goes on: its setup again when it never finished, else the same session.
    public func resume(_ projectId: String, _ id: String) async throws -> JSONValue {
        reconcile()
        halted.remove(id)
        let task = try read(projectId, id)
        if TaskStore.final.contains(task.str("status") ?? "") || live[id] != nil { return TaskStore.publicTask(task) }
        if !FS.exists(task.str("worktree") ?? "") || task.int("turn") == 0 {
            try save(projectId, id, ["status": "setting-up", "error": .null])
            Task { await self.prepare(projectId, id) }
            return TaskStore.publicTask(try read(projectId, id))
        }
        let next = try save(projectId, id) { held in ["error": .null, "messages": .array(held.arr("messages") + [self.say("engelbart", "Resumed.")])] }
        Task { await self.runTurn(projectId, id, message: BuildManager.fromEngelbart("Your last turn was cut off (Engelbart closed, it was stopped, or it failed). Your work so far is committed in the working copy. Continue where you left off.")) }
        return TaskStore.publicTask(next)
    }
}

/// While a turn works: `poke()` after anything the agent does reads the diff again `delay` later (one read at a time;
/// pokes meanwhile make one more), so the card shows each edit soon after it is made. `end()` stops it.
final class DiffWatch: @unchecked Sendable {
    private let lock = NSLock()
    private let delay: TimeInterval
    private let read: @Sendable () async -> Void
    private var timer: DispatchWorkItem?
    private var reading: Task<Void, Never>?
    private var again = false
    private var ended = false

    init(delay: TimeInterval, read: @escaping @Sendable () async -> Void) { self.delay = delay; self.read = read }

    func poke() {
        lock.lock(); defer { lock.unlock() }
        if ended || timer != nil { return }
        schedule()
    }

    private func schedule() {
        let work = DispatchWorkItem { [weak self] in self?.fire() }
        timer = work
        DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func fire() {
        lock.lock()
        timer = nil
        if reading != nil { again = true; lock.unlock(); return }
        let read = self.read
        let task = Task { await read() }
        reading = task
        lock.unlock()
        Task {
            await task.value
            lock.lock()
            reading = nil
            if again && !ended { again = false; schedule() }
            lock.unlock()
        }
    }

    /// → once a read in flight is sent, so the turn's last diff comes after it.
    func end() -> Task<Void, Never> {
        lock.lock()
        ended = true
        timer?.cancel(); timer = nil
        let inFlight = reading
        lock.unlock()
        return Task { await inFlight?.value }
    }
}
