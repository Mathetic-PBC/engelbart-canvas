import Foundation
import EngelbartCore

extension BuildManager {
    /// The library row of the repository a Build works in: the one it was started in (task.source), whatever the default
    /// is now. The default repo's is made when it has none; nil: none.
    func repositoryRow(_ projectId: String, _ task: TaskRecord) async throws -> LibraryRow? {
        let target = task.obj("target") ?? [:]
        if target["kind"]?.string == "library", let id = target["id"]?.string { return await host.libraryRow(id) }
        let at = task.str("source") ?? task.str("repo") ?? ""
        if target["kind"]?.string == "default" { return try await recordDefault(projectId, at) }
        let row = await BuildManager.rowAt(host, at)
        return row?.isRepo == true ? row : nil
    }

    /// What a run step's runnables came to, in one line for the conversation.
    static func runLine(_ runnables: [JSONValue], failure: Error?) -> String {
        if (failure as? BuildError)?.stopped == true { return "Run step stopped." }
        let said = runnables.map { item -> String in
            let type = item["type"]?.string
            let kind = type == "ui" ? "web UI" : type == "app" ? "desktop app" : "terminal"
            let runs = item["status"]?.string == "running" ? (item["url"]?.string.map { "runs at \($0)" } ?? "runs") : "did not run"
            return "\(item["name"]?.string ?? "") (\(kind)) \(runs)"
        }
        if let failure { return "Run step failed: \(failure.text)\(said.isEmpty ? "" : " \(said.joined(separator: "; ")).")" }
        return said.isEmpty ? "Run step: nothing here to run." : "Run step: \(said.joined(separator: "; "))."
    }

    /// After a turn that ended in review: what the last run step left running is stopped, and the run step runs again in
    /// the worktree, on the Build's model (Claude Code's default Build model for a Codex Build). Its changes are one
    /// checkpoint.
    func startRunStep(_ projectId: String, _ id: String) {
        guard let runStep = config.runStep, !quitting, !halted.contains(id) else { return }
        let work = Task { [self] in
            await runStep.stop(id)
            await self.runStepBody(projectId, id, runStep)
        }
        stepping[id] = work
        Task { [self] in
            await work.value
            await self.steppingDone(id, work)
        }
    }

    func steppingDone(_ id: String, _ work: Task<Void, Never>) { if stepping[id] == work { stepping[id] = nil } }

    func runStepBody(_ projectId: String, _ id: String, _ runStep: RunStep) async {
        if halted.contains(id) { return }
        guard let project = try? projectOf(projectId), let task = TaskStore.readTask(project, id), task.str("status") == "review",
              live[id] == nil, FS.exists(task.str("worktree") ?? "") else { return }
        guard let row = try? await repositoryRow(projectId, task) else {
            _ = try? save(projectId, id, ["runStep": ["status": "skipped", "turn": .number(Double(task.int("turn"))), "runnables": [],
                                                      "error": "This repository is not in the library, so nothing it runs can be kept."]])
            return
        }
        let choice = task.str("provider") == "anthropic" ? (model: task.str("modelId") ?? "", effort: task.str("effort"))
            : { let c = config.readModels().resolve(provider: "anthropic"); return (model: c.modelId, effort: Optional(c.effort)) }()
        // What the Build changed since it started, as paths in the folder it works in: where the run step looks first.
        let cwd = task.str("cwd") ?? "", worktree = task.str("worktree") ?? ""
        let diff = await git.run(cwd, ["diff", "--name-only", "--no-renames", "--relative", task.str("baseSha") ?? "", "HEAD"])
        let changed = (diff?.code == 0 ? diff!.stdout : "").components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.prefix(200)
        func put(_ change: [String: JSONValue]) {
            _ = try? save(projectId, id) { held in ["runStep": .object((held.obj("runStep") ?? [:]).merging(change) { _, b in b })] }
        }
        put(["status": "running", "turn": .number(Double(task.int("turn"))), "started": .string(Time.iso(now())), "finished": .null, "error": .null, "phase": "Starting", "runnables": []])
        var result: RunStep.Result?
        var failure: Error?
        let target = task.obj("target")
        // The run step's states reach the record in the order it said them (JS called put() synchronously).
        let states = OrderedSink()
        let input = RunStep.Input(id: id, root: cwd, name: target?["name"]?.string ?? NodePath.basename(task.str("repo") ?? ""), libraryId: row.id,
                                  runnables: RunnableStore(host.runnables), model: choice.model, effort: choice.effort, changed: Array(changed),
                                  onState: { state in states.push { await self.putRunStep(projectId, id, state) } },
                                  turn: task.int("turn"), title: task.str("title"), projectId: projectId, projectName: project.name,
                                  workspaceName: workspaceNameOf(projectId, task))
        do { result = try await runStep.run(input) } catch { failure = error }
        await states.drain()
        // What the run step changed: a checkpoint of its own, which Review shows apart from the Build's work.
        let sha = try? await git.checkpoint(worktree, "Build \(task.str("title") ?? ""): run step", await git.identity(task.str("repo") ?? worktree))
        let at = Time.iso(now())
        let line = BuildManager.runLine(result?.runnables ?? [], failure: failure)
        let stopped = (failure as? BuildError)?.stopped == true
        _ = try? save(projectId, id) { held in
            var step = held.obj("runStep") ?? [:]
            if let result { step["runnables"] = .array(result.runnables) }
            step["status"] = .string(failure != nil ? (stopped ? "stopped" : "failed") : "done")
            step["phase"] = .null
            step["error"] = failure != nil && !stopped ? .string(failure!.text) : .null
            step["finished"] = .string(at)
            step["changed"] = .bool(sha != nil)
            var checkpoints = held.arr("checkpoints")
            if let s = sha { checkpoints.append(["sha": .string(s), "turn": .number(Double(held.int("turn"))), "at": .string(at), "step": "run"]) }
            return ["checkpoints": .array(checkpoints), "runStep": .object(step), "messages": .array(held.arr("messages") + [self.say("engelbart", line)])]
        }
    }

    func putRunStep(_ projectId: String, _ id: String, _ state: JSONValue) {
        guard let change = state.object else { return }
        _ = try? save(projectId, id) { held in
            // A late state from a step that already finished never reopens it.
            var step = held.obj("runStep") ?? [:]
            if let status = step["status"]?.string, status != "running" { step["runnables"] = change["runnables"] ?? step["runnables"]; return ["runStep": .object(step)] }
            for (k, v) in change { step[k] = v }
            return ["runStep": .object(step)]
        }
    }

    /// A run step that is working ends now: its agent stops, and its changes become its checkpoint.
    func haltRunStep(_ id: String) async {
        guard let work = stepping[id] else { return }
        if let runStep = config.runStep { await runStep.halt(id) }
        await work.value
    }

    /// Everything a Build's run steps started is stopped (Accept, Discard).
    func stopRunStep(_ id: String) async {
        await haltRunStep(id)
        await config.runStep?.stop(id)
    }

    /// The record's run step once what it started is stopped: nothing it lists runs any more.
    static func stoppedRunStep(_ held: TaskRecord) -> TaskRecord {
        guard var step = held.obj("runStep") else { return [:] }
        step["runnables"] = .array((step["runnables"]?.array ?? []).map { item in
            guard item["status"]?.string == "running", var o = item.object else { return item }
            o["status"] = "stopped"; o["sessionId"] = .null; o["pid"] = .null
            return .object(o)
        })
        return ["runStep": .object(step)]
    }

    /// What the Build's last run step found, written to the repository's rows once the Build is accepted (`commit`: what
    /// landed, or the commit it ran on when nothing changed): a runnable that passed with its commands, verified at that
    /// commit; one that failed with its last error. Only then.
    func recordRunnables(_ projectId: String, _ task: TaskRecord, commit: String) async throws -> Int {
        let list = (task.obj("runStep")?["runnables"]?.array ?? []).filter { $0["passed"]?.bool == true || $0["status"]?.string == "failed" }
        if list.isEmpty { return 0 }
        guard let row = try await repositoryRow(projectId, task) else { return 0 }
        let rows = RunnableStore(host.runnables)
        for item in list {
            let kept = try await rows.declare(row.id, folder: item["folder"]?.string, name: item["name"]?.string ?? "", type: item["type"]?.string ?? "")
            if item["passed"]?.bool == true { try await rows.verify(kept.id, install: item["install_command"]?.string, run: item["run_command"]?.string, commit: commit) }
            else { try await rows.fail(kept.id, item["error"]?.string ?? "It did not pass its check.") }
        }
        return list.count
    }

    /// A runnable the run step got running, opened for the person (from Review): a UI in a Stage tab, a terminal program in
    /// Engelbart's terminal (a session of its own), a desktop app's window brought to the front.
    public func showRunnable(_ projectId: String, _ id: String, _ name: String) async throws -> Bool {
        let task = try read(projectId, id)
        guard let item = (task.obj("runStep")?["runnables"]?.array ?? []).first(where: { $0["name"]?.string == name }), item["status"]?.string == "running" else {
            throw BuildError("\(name) is not running.")
        }
        if item["type"]?.string == "ui", let url = item["url"]?.string {
            config.notify("engelbart:build-run", ["projectId": .string(projectId), "id": .string(id), "kind": "ui", "name": .string(name), "url": .string(url)])
            return true
        }
        guard let runStep = config.runStep else { throw BuildError("\(name) cannot be opened here.") }
        if item["type"]?.string == "app" {
            if !(await runStep.focus(id, folder: item["folder"]?.string ?? ".", name: name)) { throw BuildError("\(name)'s window could not be brought to the front.") }
            return true
        }
        guard let command = item["run_command"]?.string else { throw BuildError("\(name) has no command to open.") }
        let cwd = try RunTools.worktreePath(task.str("cwd") ?? "", item["folder"]?.string ?? ".")
        let session = try runStep.terminal(id, name: name, cwd: cwd, command: command, sessionId: item["sessionId"]?.string)
        if let sid = session["id"]?.string, sid != item["sessionId"]?.string {
            _ = try? save(projectId, id) { held in
                guard var step = held.obj("runStep") else { return [:] }
                step["runnables"] = .array((step["runnables"]?.array ?? []).map { e in
                    guard e["name"]?.string == name, var o = e.object else { return e }
                    o["sessionId"] = .string(sid); return .object(o)
                })
                return ["runStep": .object(step)]
            }
        }
        config.notify("engelbart:build-run", ["projectId": .string(projectId), "id": .string(id), "kind": "terminal", "name": .string(name), "session": session])
        return true
    }

    /// An accepted Build's kept copy goes (its last runnable stopped, Engelbart quitting): what its run steps started is
    /// stopped, then its worktree and branch are removed.
    func releaseCopy(_ projectId: String, _ id: String, note: String) async {
        keptCopies[id] = nil
        await config.runStep?.stop(id)
        guard let project = try? projectOf(projectId), let task = TaskStore.readTask(project, id) else { return }
        await cleanUp(task)
        _ = try? save(projectId, id) { held in
            var n = BuildManager.stoppedRunStep(held)
            n["keptCopy"] = false
            n["messages"] = .array(held.arr("messages") + [self.say("engelbart", note)])
            return n
        }
    }

    /// On an accepted Build's card (its copy kept while something runs): one runnable stopped (`name`), or all (nil). The
    /// copy goes with the last one.
    public func stopRunnable(_ projectId: String, _ id: String, _ name: String?) async throws -> JSONValue {
        let task = try read(projectId, id)
        if task.str("status") != "accepted" || !task.truthy("keptCopy") { throw BuildError("Nothing of this Build is running.") }
        let runnables = task.obj("runStep")?["runnables"]?.array ?? []
        let item = name.flatMap { n in runnables.first { $0["name"]?.string == n && $0["status"]?.string == "running" } }
        if let name, item == nil { throw BuildError("\(name) is not running.") }
        if let item, let name, runnables.contains(where: { $0["name"]?.string != name && $0["status"]?.string == "running" }) {
            await config.runStep?.stopOne(id, folder: item["folder"]?.string ?? ".", name: name)
            _ = try save(projectId, id) { held in
                var step = held.obj("runStep") ?? [:]
                step["runnables"] = .array((step["runnables"]?.array ?? []).map { e in
                    guard e["name"]?.string == name, var o = e.object else { return e }
                    o["status"] = "stopped"; o["sessionId"] = .null; o["pid"] = .null; return .object(o)
                })
                return ["runStep": .object(step)]
            }
        } else {
            let names = runnables.filter { $0["status"]?.string == "running" }.compactMap { $0["name"]?.string }
            await releaseCopy(projectId, id, note: "Stopped \(names.joined(separator: ", ")). Nothing of it runs now, and its copy is removed.")
        }
        return try get(projectId, id)
    }

    /// A copy an accepted Build kept when Engelbart closed without stopping it (it crashed): what it ran is stopped (a
    /// process group only while it is still the one started there), then the copy goes.
    func sweepCopy(_ project: BuildProject, _ task: TaskRecord) async {
        let worktree = task.str("worktree") ?? "", repo = task.str("repo") ?? "", branch = task.str("branch") ?? ""
        if FS.exists(worktree) {
            for item in task.obj("runStep")?["runnables"]?.array ?? [] {
                if let pid = item["pid"]?.int, let runStep = config.runStep { _ = await runStep.stopLeftover(Int32(pid), within: worktree) }
            }
            await cleanUp(task)
        } else {
            let git = self.git
            _ = try? await serial(repo) { await git.deleteBranch(repo, branch) }
        }
        guard let id = task.str("id"), let held = TaskStore.readTask(project, id) else { return }
        var next = held.merging(BuildManager.stoppedRunStep(held))
        next["keptCopy"] = false
        next["messages"] = .array(held.arr("messages") + [say("engelbart", "Engelbart closed without stopping what ran on it; it was stopped when Engelbart started again, and its copy removed.")])
        if let written = try? TaskStore.writeTask(project, next, now: now()) { emit(written) }
    }

    /// The run step that is working stops; what already passed keeps running.
    public func stopRunning(_ projectId: String, _ id: String) async throws -> JSONValue {
        _ = try read(projectId, id)
        await haltRunStep(id)
        return try get(projectId, id)
    }
}
