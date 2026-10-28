import Foundation
import EngelbartCore

extension BuildManager {
    // MARK: review

    public func review(_ projectId: String, _ id: String) async throws -> JSONValue {
        reconcile()
        let task = try read(projectId, id)
        let worktree = task.str("worktree") ?? "", base = task.str("baseSha") ?? "", from = task["baseBranch"] ?? .null
        if task.str("status") == "accepted", let accepted = task.obj("accepted"), let sha = accepted["sha"]?.string {
            var d = try await git.diff(task.str("repo") ?? "", "\(sha)^", sha).json
            d["from"] = from; d["sha"] = .string(sha)
            return .object(d)
        }
        if !FS.exists(worktree) { throw BuildError("This Build's copy is gone.") }
        let running = live[id] != nil
        let base_: [String: JSONValue] = ["from": from, "base": .string(base), "running": .bool(running), "stepping": .bool(stepping[id] != nil)]
        func merged(_ d: [String: JSONValue], _ extra: [String: JSONValue] = [:]) -> JSONValue { .object(d.merging(base_) { _, b in b }.merging(extra) { _, b in b }) }
        // The run steps' changes apart: the Build's own work is HEAD without them.
        let runs = task.arr("checkpoints").filter { $0["step"]?.string == "run" }.compactMap { $0["sha"]?.string }
        // While a turn works, or with no run step's changes: as the worktree stands, what the agent has not saved yet too;
        // nothing is committed for it (2026-09-29).
        if running || (runs.isEmpty && stepping[id] == nil) {
            return merged(try await git.workingDiff(worktree, base, maxPatch: BuildManager.cardPatch).json)
        }
        let d = try await git.diff(worktree, base, "HEAD")
        if runs.isEmpty { return merged(d.json) }
        if let own = try? await git.treeWithout(worktree, runs) {
            var step = try await git.diff(worktree, own, "HEAD").json
            step["apart"] = true
            return merged(try await git.diff(worktree, base, own).json, ["runStep": .object(step)])
        }
        // A later turn changed the same lines: everything together, and each run step's own changes as it made them.
        var parts: [GitDiff] = []
        for sha in runs { parts.append(try await git.diff(worktree, "\(sha)^", sha)) }
        return merged(d.json, ["runStep": ["files": .array(parts.flatMap { $0.files.map(\.json) }), "patch": .string(parts.map(\.patch).joined(separator: "\n")),
                                           "truncated": .bool(parts.contains { $0.truncated }), "apart": false]])
    }

    // MARK: accept

    static func checkCommand(_ project: BuildProject, _ task: TaskRecord) -> String? {
        let own = Files.readJSON(URL(fileURLWithPath: NodePath.join(project.dir, "project.json")))?.object ?? [:]
        if let check = own["build"]?["check"]?.string { let t = check.trimmingCharacters(in: .whitespacesAndNewlines); return t.isEmpty ? nil : t }
        if let pkg = Files.readJSON(URL(fileURLWithPath: NodePath.join(task.str("cwd") ?? "", "package.json"))),
           let test = pkg["scripts"]?["test"]?.string, !test.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !test.contains("no test specified") {
            return "npm test"
        }
        return nil
    }

    static func lastSummary(_ task: TaskRecord) -> String {
        guard let said = task.arr("messages").last(where: { $0["role"]?.string == "agent" }) else { return "" }
        return String((said["text"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(3000))
    }

    /// `auto`: a quick task landing by itself. `attempt`: this is Accept run again after the agent's fix number `attempt`
    /// (0: the person pressed it). A conflict or failed checks go to the agent while fixes are left (autoFixes).
    @discardableResult
    public func accept(_ projectId: String, _ id: String, auto: Bool = false, attempt: Int = 0) async throws -> JSONValue {
        reconcile()
        if !auto && attempt == 0 { halted.remove(id) }
        else if halted.contains(id) { throw BuildError("Its project is being deleted.") }
        let project = try projectOf(projectId)
        let task = try read(projectId, id)
        let status = task.str("status") ?? ""
        if TaskStore.final.contains(status) { return TaskStore.publicTask(task) }
        if live[id] != nil || status == "setting-up" || status == "accepting" { throw BuildError("It is still working.") }
        let worktree = task.str("worktree") ?? "", repo = task.str("repo") ?? "", branch = task.str("branch") ?? "", title = task.str("title") ?? ""
        if !FS.exists(worktree) { throw BuildError("This Build's copy is gone; discard it.") }
        await haltRunStep(id) // what a working run step changed is part of what is accepted
        let before = status
        try save(projectId, id, ["status": "accepting", "error": .null, "conflict": .null])
        do {
            let git = self.git
            return try await serial(repo) { [self] in
                let who = await git.identity(repo)
                try await git.concludeMerge(worktree, "Build \(title): before accept", who)
                let target = try await git.head(repo)
                guard let targetBranch = target.branch else { throw BuildError("Your code folder is not on a branch.") }
                let base = try await git.mergeBase(worktree, branch, target.sha)
                let tip = try await git.revParse(worktree, branch)
                let turns = task.arr("checkpoints").count
                let body = [BuildManager.lastSummary(task), "Engelbart Build \(id) · \(task.str("modelName") ?? "") \(task.str("effort") ?? "") · \(turns) \(turns == 1 ? "turn" : "turns")"].filter { !$0.isEmpty }.joined(separator: "\n\n")
                var sha: String?
                do {
                    sha = tip == base ? nil : try await git.squashOnto(worktree, branch: branch, base: base, onto: target.sha, message: "\(title)\n\n\(body)\n", who: who)
                } catch let error as GitError where error.code == "conflict" {
                    var e = BuildError("\(targetBranch) and this Build changed the same lines in \(error.files.joined(separator: ", ")).", code: "conflict")
                    e.files = error.files
                    throw e
                }
                var checks: JSONValue = .null
                if let sha {
                    // A conflict the agent left half resolved never lands: its markers send the Build back to its conflict.
                    let marked = try await git.markers(worktree, target.sha, sha)
                    if !marked.isEmpty {
                        try await git.checkoutBranch(worktree, branch)
                        var e = BuildError("\(marked.joined(separator: ", ")) still \(marked.count == 1 ? "holds" : "hold") conflict markers.", code: "conflict")
                        e.files = marked; e.markers = true
                        throw e
                    }
                    if let command = BuildManager.checkCommand(project, task) {
                        let ran = await self.config.runShell(command, task.str("cwd") ?? worktree, [:])
                        checks = ["command": .string(command), "ok": .bool(ran.ok), "output": .string(ran.output), "at": .string(Time.iso(await self.now()))]
                        if !ran.ok {
                            try await git.checkoutBranch(worktree, branch)
                            var e = BuildError("The checks failed (\(command)).")
                            e.checks = checks
                            throw e
                        }
                    }
                    do { try await git.fastForward(repo, branch: targetBranch, expected: target.sha, sha: sha) }
                    catch { try? await git.checkoutBranch(worktree, branch); throw error }
                }
                return try await self.landed(projectId, id, task: task, sha: sha, tip: tip, targetBranch: targetBranch, checks: checks, auto: auto)
            }
        } catch {
            let b = error as? BuildError
            let conflict = b?.code == "conflict"
            let fixable = conflict || b?.checks != nil
            let again = !auto && fixable && attempt < config.autoFixes // back to the agent, then Accept again
            let gaveUp = !auto && fixable && attempt > 0 && !again
            let note = gaveUp ? " Still refused after the agent's \(attempt == 1 ? "fix" : "\(attempt) fixes"); press Accept to send it again." : ""
            let next = try save(projectId, id) { held in
                ["status": .string(conflict ? "conflict" : ["accepting", "conflict"].contains(before) ? "review" : before),
                 "error": .string(error.text),
                 "conflict": conflict ? ["files": .array((b?.files ?? []).map(JSONValue.string)), "markers": .bool(b?.markers ?? false)] : .null,
                 "checks": b?.checks ?? (held.truthy("checks") ? held["checks"]! : .null),
                 "landing": again ? ["attempt": .number(Double(attempt + 1))] : .null,
                 "messages": .array(held.arr("messages") + [self.say("engelbart", "Not accepted: \(error.text)\(note)")])]
            }
            if again {
                do { return try await sendFix(projectId, id) }
                catch let failure {
                    let left = try save(projectId, id) { held in
                        ["landing": .null, "error": .string(failure.text), "messages": .array(held.arr("messages") + [self.say("engelbart", "It could not be sent to the agent: \(failure.text)")])]
                    }
                    if attempt > 0 { return TaskStore.publicTask(left) }
                    throw failure
                }
            }
            if auto || attempt > 0 { return TaskStore.publicTask(next) }
            throw error
        }
    }

    /// It landed (or had nothing to land): what its run step found is the repository's now, the copy kept while
    /// something runs, the record accepted.
    func landed(_ projectId: String, _ id: String, task: TaskRecord, sha: String?, tip: String, targetBranch: String, checks: JSONValue, auto: Bool) async throws -> JSONValue {
        let project = try projectOf(projectId)
        let landed = TaskStore.readTask(project, id) ?? task
        var unkept: String?
        do { _ = try await recordRunnables(projectId, landed, commit: sha ?? tip) } catch { unkept = error.text }
        // What runs stays up (2026-09-29): the copy stays, detached at what landed (squashOnto left it there), until its
        // last runnable is stopped, Engelbart quits, or (after a crash) starts.
        let up = (landed.obj("runStep")?["runnables"]?.array ?? []).filter { $0["status"]?.string == "running" }.compactMap { $0["name"]?.string }
        let keep = config.runStep != nil && !up.isEmpty && config.runStep!.holds(id)
        let worktree = task.str("worktree") ?? ""
        if keep {
            if sha == nil { _ = await git.run(worktree, ["checkout", "--quiet", "--detach"]) }
            keptCopies[id] = projectId
        } else {
            await config.runStep?.stop(id) // what the run steps started runs in the worktree: stopped before it goes
            await removeCopy(task) // inside this repository's turn already: not cleanUp, which would wait for it
        }
        let at = Time.iso(now())
        let message = "\(sha.map { "Accepted onto \(targetBranch) as \($0.prefix(7))\(auto ? " (a quick task that finished cleanly lands by itself)" : "")." } ?? "Nothing had changed, so there was nothing to accept.")"
            + (keep ? " \(up.joined(separator: ", ")) \(up.count == 1 ? "keeps" : "keep") running on it until you stop \(up.count == 1 ? "it" : "them")." : "")
            + (unkept.map { " What its run step found could not be kept: \($0)" } ?? "")
        let done = try save(projectId, id) { held in
            var next: TaskRecord = keep ? ["keptCopy": true] : BuildManager.stoppedRunStep(held)
            next["status"] = "accepted"; next["finished"] = .string(at); next["checks"] = checks; next["queued"] = .null; next["landing"] = .null
            next["accepted"] = sha.map { ["sha": .string($0), "branch": .string(targetBranch), "at": .string(at)] } ?? .null
            next["messages"] = .array(held.arr("messages") + [self.say("engelbart", message)])
            return next
        }
        let host = self.host
        track { host.agentStopped(id) }
        return TaskStore.publicTask(done)
    }

    // MARK: fix

    /// A refused Accept sent to the agent (by Accept itself since 2026-09-29; "Send to agent" before): for a conflict
    /// Engelbart merges the person's branch into the Build's (the markers left in the files), for failed checks it passes
    /// their output; either way the same session takes it up. A branch that merges in cleanly needs no turn.
    public func fix(_ projectId: String, _ id: String) async throws -> JSONValue {
        reconcile()
        halted.remove(id)
        return try await sendFix(projectId, id)
    }

    func sendFix(_ projectId: String, _ id: String) async throws -> JSONValue {
        let task = try read(projectId, id)
        if live[id] != nil { return TaskStore.publicTask(task) }
        let worktree = task.str("worktree") ?? "", repo = task.str("repo") ?? "", title = task.str("title") ?? ""
        var note: String
        var summary: String
        if task.str("status") == "conflict" {
            let target = try await git.head(repo)
            let git = self.git
            let files = try await serial(repo) { try await git.mergeInto(worktree, target.sha, await git.identity(repo)) }
            let conflict = task.obj("conflict")
            let left: [String] = conflict?["markers"]?.bool == true ? (conflict?["files"]?.array?.compactMap(\.string) ?? []) : []
            let theirs = target.branch ?? "the person's branch"
            if files.isEmpty && left.isEmpty {
                try await git.concludeMerge(worktree, "Build \(title): \(target.branch ?? "") merged in", await git.identity(repo))
                let merged = try save(projectId, id) { held in
                    ["status": "review", "conflict": .null, "error": .null,
                     "messages": .array(held.arr("messages") + [self.say("engelbart", "\(target.branch ?? "Your branch") merged in without conflicts.\(held.truthy("landing") ? "" : " Accept again.")")])]
                }
                if let landing = merged.obj("landing") { return try await accept(projectId, id, attempt: landing["attempt"]?.int ?? 0) }
                return TaskStore.publicTask(merged)
            }
            if !files.isEmpty {
                note = "To accept this Build, Engelbart merged \(theirs) (at \(target.sha.prefix(7))) into your branch, and both sides had changed the same lines in \(files.joined(separator: ", ")). Those files now hold conflict markers. Resolve them so both changes survive, check the result, and reply as usual."
                summary = "Sent the conflict in \(files.joined(separator: ", ")) to the agent."
            } else {
                try await git.concludeMerge(worktree, "Build \(title): \(target.branch ?? "") merged in", await git.identity(repo))
                note = "\(left.joined(separator: ", ")) still \(left.count == 1 ? "holds" : "hold") conflict markers (lines starting <<<<<<< or >>>>>>>) from an earlier merge with \(theirs). Resolve them so both changes survive, check the result, and reply as usual."
                summary = "Sent the conflict markers left in \(left.joined(separator: ", ")) to the agent."
            }
        } else if let checks = task.obj("checks"), checks["ok"]?.bool == false {
            let command = checks["command"]?.string ?? ""
            note = "The project's checks failed when this Build was about to be accepted:\n\n$ \(command)\n\(checks["output"]?.string ?? "")\n\nFix what fails, run them again, and reply as usual."
            summary = "Sent the failed checks (\(command)) to the agent."
        } else {
            return TaskStore.publicTask(task)
        }
        let next = try save(projectId, id) { held in
            let said = held.truthy("landing") ? "\(summary.hasSuffix(".") ? String(summary.dropLast()) : summary); Accept runs again when it is done." : summary
            return ["conflict": .null, "error": .null, "messages": .array(held.arr("messages") + [self.say("engelbart", said)])]
        }
        let message = BuildManager.fromEngelbart(note)
        Task { await self.runTurn(projectId, id, message: message) }
        return TaskStore.publicTask(next)
    }

    // MARK: discard

    func removeCopy(_ task: TaskRecord) async {
        let repo = task.str("repo") ?? "", worktree = task.str("worktree") ?? "", branch = task.str("branch") ?? ""
        await git.removeWorktree(repo, worktree)
        await git.deleteBranch(repo, branch)
    }

    func cleanUp(_ task: TaskRecord) async {
        let git = self.git
        let repo = task.str("repo") ?? "", worktree = task.str("worktree") ?? "", branch = task.str("branch") ?? ""
        _ = try? await serial(repo) { await git.removeWorktree(repo, worktree); await git.deleteBranch(repo, branch) }
    }

    public func discard(_ projectId: String, _ id: String) async throws -> JSONValue {
        reconcile()
        let task = try read(projectId, id)
        if TaskStore.final.contains(task.str("status") ?? "") { return TaskStore.publicTask(task) }
        if let entry = live[id] { stop(projectId, id); await waitDone(entry) }
        if try read(projectId, id).str("status") == "accepting" { throw BuildError("It is being accepted.") }
        await stopRunStep(id) // everything its run steps started
        let at = Time.iso(now())
        let next = try save(projectId, id) { held in
            var n = BuildManager.stoppedRunStep(held)
            n["status"] = "discarded"; n["queued"] = .null; n["finished"] = .string(at)
            n["messages"] = .array(held.arr("messages") + [self.say("engelbart", "Discarded.")])
            return n
        }
        let host = self.host
        track { host.agentStopped(id) }
        if task.str("status") != "setting-up" { await cleanUp(task) } // a Build still being set up is cleaned up when that ends
        return TaskStore.publicTask(next)
    }

    /// A quick task that turned out big (B23): it becomes a Build of `workspaceId`, and the same session goes on. Its
    /// post-it is put in as an archived version of the workspace (2026-09-27), and the workspace joins ⌘J's recent ones.
    public func promote(_ projectId: String, _ id: String, workspaceId: String, picked: (provider: String?, model: String?, effort: String?)? = nil) async throws -> JSONValue {
        reconcile()
        halted.remove(id)
        let task = try read(projectId, id)
        if task.str("kind") != "quick" || TaskStore.final.contains(task.str("status") ?? "") || live[id] != nil {
            throw BuildError("Only a quick task that is not working can become a Build.")
        }
        let workspace = try host.workspace(projectId, workspaceId)
        // Another model of the same provider goes on in the same session; another provider cannot: its first turn gets
        // everything again.
        let choice = picked.map { config.readModels().resolve(provider: $0.provider, model: $0.model, effort: $0.effort) }
        let moved = choice != nil && choice!.provider != task.str("provider")
        let project = try projectOf(projectId)
        let version = try await host.importTask(projectId, workspace.id, text: BuildManager.postItOf(task, TaskStore.readContext(project, id)), buildId: id)
        try host.addWorkspaceBuild(projectId, workspace.id, id)
        let host = self.host
        track { host.recordEdit(projectId, workspace.id) }
        let changed = choice.map { $0.provider != task.str("provider") || $0.model != task.str("model") || $0.effort != task.str("effort") } ?? false
        let next = try save(projectId, id) { held in
            var n: TaskRecord = ["kind": "build", "workspaceId": .string(workspace.id), "version": version, "escalation": .null]
            if let choice { for (k, v) in choice.record { n[k] = v } }
            if moved { n["sessionId"] = .null }
            n["messages"] = .array(held.arr("messages") + [self.say("engelbart", "Moved to the workspace \"\(workspace.name)\" as a Build\(changed ? " on \(choice!.modelName) \(choice!.effort)" : "").")])
            return n
        }
        Task { await self.runTurn(projectId, id, message: BuildManager.fromEngelbart("This is now a full Build, not a quick task: larger changes are fine, and you may ask the person a question with NEEDS YOU. Go ahead with what the post-it asked for.")) }
        return TaskStore.publicTask(next)
    }

    // MARK: trash

    /// Its project goes into the trash: each turn of its Builds stops, its work saved and the Build `stopped`; what their
    /// run steps started is stopped; an accepted Build's kept copy goes; a record left working with nothing at work on it
    /// is `interrupted`. Nothing of theirs starts again by itself. Refused while one is being accepted.
    public func stopProject(_ projectId: String) async throws {
        reconcile()
        let project = try projectOf(projectId)
        let tasks = TaskStore.listTasks(project)
        if tasks.contains(where: { $0.str("status") == "accepting" }) { throw BuildError("A Build of this project is being accepted; delete the project once that is done.") }
        let ids = tasks.compactMap { $0.str("id") }
        for id in ids { halted.insert(id) }
        let running = ids.compactMap { live[$0] }
        for id in ids { stop(projectId, id) }
        for entry in running { await waitDone(entry) }
        for id in ids {
            await stopRunStep(id)
            if keptCopies[id] != nil { await releaseCopy(projectId, id, note: "Its project was deleted: what ran on it was stopped, and its copy removed.") }
        }
        for task in TaskStore.listTasks(project) {
            let id = task.str("id") ?? "", status = task.str("status") ?? ""
            if TaskStore.final.contains(status) { continue }
            let left = TaskStore.working.contains(status) && live[id] == nil // being set up, or cut short for a reply: Resume goes on
            let ran = (task.obj("runStep")?["runnables"]?.array ?? []).contains { $0["status"]?.string == "running" }
            if left || ran {
                _ = try? save(projectId, id) { held in
                    var n = BuildManager.stoppedRunStep(held)
                    if left { n["status"] = "interrupted"; n["messages"] = .array(held.arr("messages") + [self.say("engelbart", "Its project was deleted while this was working.")]) }
                    return n
                }
            }
        }
        let host = self.host
        track { for id in ids { host.agentStopped(id) } }
    }

    /// A trashed project purged: each Build's worktree and branch removed, one repository at a time; what fails is left.
    public func removeWorktrees(_ tasks: [TaskRecord]) async {
        for task in tasks {
            guard task.str("repo") != nil, task.str("worktree") != nil else { continue }
            if let id = task.str("id") { halted.remove(id) }
            await cleanUp(task)
        }
    }

    /// A Build's copy follows its project back from the trash under another folder name.
    public func moveWorktree(_ task: TaskRecord, to: String) async throws {
        let git = self.git, repo = task.str("repo") ?? "", from = task.str("worktree") ?? ""
        _ = try await serial(repo) { try await git.moveWorktree(repo, from, to) }
    }

    // MARK: recovery

    /// Records left working by an app that closed are interrupted (B19); a Build whose copy is gone has failed. Once per
    /// data root.
    public func reconcile() {
        let root = host.dataRoot
        if reconciled.contains(root) { return }
        reconciled.insert(root)
        var left: [(BuildProject, TaskRecord)] = []
        for project in host.projectRecords() {
            for task in TaskStore.listTasks(project) {
                let id = task.str("id") ?? "", status = task.str("status") ?? ""
                if TaskStore.final.contains(status) && task.truthy("keptCopy") && keptCopies[id] == nil { left.append((project, task)) } // it crashed while it ran
                if TaskStore.final.contains(status) || live[id] != nil { continue }
                let gone = status != "setting-up" && !FS.exists(task.str("worktree") ?? "")
                var runStepLeft: TaskRecord = [:]
                if var step = task.obj("runStep"), step["status"]?.string == "running" { step["status"] = "stopped"; step["phase"] = .null; runStepLeft["runStep"] = .object(step) }
                if gone {
                    _ = try? TaskStore.writeTask(project, task.merging(runStepLeft).merging(["status": "failed", "error": "This Build's copy is gone.",
                        "messages": .array(task.arr("messages") + [say("engelbart", "This Build's copy is gone; discard it.")])]), now: now())
                } else if TaskStore.working.contains(status) {
                    _ = try? TaskStore.writeTask(project, task.merging(runStepLeft).merging(["status": "interrupted", "landing": .null,
                        "messages": .array(task.arr("messages") + [say("engelbart", "Engelbart closed while this was working.")])]), now: now())
                } else if !runStepLeft.isEmpty {
                    _ = try? TaskStore.writeTask(project, task.merging(runStepLeft), now: now())
                }
            }
        }
        for (project, task) in left {
            let key = UUID()
            sweeps[key] = Task { await self.sweepCopy(project, task); await self.sweepDone(key) }
        }
    }

    func sweepDone(_ key: UUID) { sweeps[key] = nil }

    /// Quit: every turn is stopped and its checkpoint saved (at most 20 s), and becomes `interrupted`; what run steps
    /// started is stopped, and the copies accepted Builds kept for it go.
    public func stopAll() async {
        quitting = true
        let running = Array(live.values)
        for entry in running { entry.stopping = "quit"; entry.signal.abort() }
        let kept = keptCopies
        let steps = Array(stepping.values), swept = Array(sweeps.values)
        let runStep = config.runStep
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                await withTaskGroup(of: Void.self) { all in
                    for entry in running { all.addTask { await self.waitDone(entry) } }
                    if let runStep {
                        all.addTask {
                            await runStep.stopAll()
                            for (id, projectId) in kept { await self.releaseCopy(projectId, id, note: "Engelbart closed: what ran on it was stopped, and its copy removed.") }
                        }
                        for s in steps { all.addTask { await s.value } }
                        for s in swept { all.addTask { await s.value } }
                    }
                }
            }
            group.addTask { try? await Task.sleep(nanoseconds: UInt64(BuildManager.quitWait * 1_000_000_000)) }
            await group.next()
            group.cancelAll()
        }
    }
}
