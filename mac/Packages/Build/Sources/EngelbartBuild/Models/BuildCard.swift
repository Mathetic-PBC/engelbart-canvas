import Foundation
import EngelbartCore

/// What a `build> <id>` line's card shows (DocEditor.jsx buildParts / buildRunHtml / buildDiffHtml), as data: the Editor
/// draws it (or embeds BuildCardView). Parts in order: head, prompt, body, run, live, diff, reply, actions.
public struct BuildCardModel: Equatable, Sendable {
    public static let statusWords = ["setting-up": "Setting up", "queued": "Waiting for a slot", "running": "Working", "needs-you": "Needs you",
                                     "review": "Ready to review", "stopped": "Stopped", "failed": "Failed", "escalated": "Too big for a quick task",
                                     "interrupted": "Interrupted", "accepting": "Accepting", "conflict": "Conflict", "accepted": "Accepted", "discarded": "Discarded"]
    public static let working: Set<String> = ["setting-up", "queued", "running", "accepting"]

    /// A button of the card: `act` as DocEditor names it (buildpreview, buildresume, buildreject, buildaccept, buildreview,
    /// buildremove, buildstop, buildrunstop, buildrunstopall, buildrunshow, buildrunstopone, buildsend, buildhistory,
    /// buildsteps, buildprompt); `run`: the runnable it is for.
    public struct Action: Equatable, Sendable {
        public var act: String
        public var label: String
        /// box (white with a hairline), primary (Accept's blue), text (grey, ink on hover)
        public var style: String
        public var disabled = false
        public var title = ""
        public var run: String?
    }

    public struct RunRow: Equatable, Sendable {
        public var name: String
        public var kind: String
        public var state: String
        /// green running, red failed, grey otherwise
        public var tone: String
        public var error: String?
        public var actions: [Action]
    }

    public var missing = false
    public var title = ""
    public var model = ""
    public var effort = ""
    /// The status word; "Getting it running…" while the run step works.
    public var status = ""
    public var statusKey = ""
    /// blue (needs-you, review), red (failed, conflict), grey
    public var statusTone = "grey"
    public var prompt: String?
    public var hiddenMessages = 0
    public var messages: [JSONValue] = []
    public var question: String?
    public var escalation: String?
    public var failedChecks: (command: String, output: String)?
    public var sending: String?
    public var working = false
    /// What it is doing (the live row) and Stop.
    public var doing: String?
    public var canStop = false
    public var runLabel: String?
    public var runNote: String?
    public var runWorking = false
    public var runFailed = false
    public var runRows: [RunRow] = []
    public var runActions: [Action] = []
    public var replyPlaceholder: String?
    public var actions: [Action] = []
    public var errorLine: String?

    public static func == (a: BuildCardModel, b: BuildCardModel) -> Bool {
        a.title == b.title && a.status == b.status && a.actions == b.actions && a.runRows == b.runRows && a.messages == b.messages && a.doing == b.doing
            && a.errorLine == b.errorLine && a.prompt == b.prompt && a.replyPlaceholder == b.replyPlaceholder && a.runLabel == b.runLabel && a.runNote == b.runNote
    }

    /// `task`: the public record (nil: not in this project); `progress`: what a running turn is doing ({ activity });
    /// `open`: the earlier messages shown.
    public init(id: String, task: JSONValue?, progress: JSONValue? = nil, open: Bool = false) {
        guard let task, !task.isNull else {
            missing = true
            title = "\(id) is not in this project."
            actions = [Action(act: "buildremove", label: "Remove", style: "text")]
            return
        }
        let status = task["status"]?.string ?? ""
        working = BuildCardModel.working.contains(status) || task["working"]?.bool == true
        let final = task["final"]?.bool == true
        // A turn that ended in review whose run step is still getting it running (2026-09-29): Review and Accept wait.
        let step = task["runStep"]
        let stepping = status == "review" && step?["status"]?.string == "running"
        title = task["title"]?.string ?? ""
        model = task["modelName"]?.string ?? task["model"]?.string ?? ""
        effort = EffortLabels.label(task["effort"]?.string ?? "")
        statusKey = stepping ? "getting-it-running" : status
        self.status = stepping ? "Getting it running…" : BuildCardModel.statusWords[status] ?? status
        statusTone = stepping ? "grey" : ["needs-you", "review"].contains(status) ? "blue" : ["failed", "conflict"].contains(status) ? "red" : "grey"
        // What it was given (2026-10-13): a line's request, a post-it's text, the panel's.
        if let asked = task["postIt"]?.string, !asked.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { prompt = asked }
        // The conversation: from the agent's last message on; the earlier ones behind a count. A closed Build: its last note.
        let all = task["messages"]?.array ?? []
        var from = all.lastIndex { $0["role"]?.string == "agent" } ?? 0
        if final { from = max(0, all.count - 1) }
        hiddenMessages = open ? 0 : from
        messages = Array(all[hiddenMessages...])
        if status == "needs-you" { question = task["question"]?.string }
        if status == "escalated" { escalation = task["escalation"]?.string }
        if let checks = task["checks"], checks["ok"]?.bool == false, !final {
            failedChecks = (checks["command"]?.string ?? "", (checks["output"]?.string ?? "").components(separatedBy: "\n").suffix(12).joined(separator: "\n"))
        }
        if let queued = task["queued"]?.string, !queued.isEmpty { sending = queued.count > 140 ? String(queued.prefix(139)) + "…" : queued }
        if working {
            doing = status == "running" ? (progress?["activity"]?.string ?? "Thinking") : BuildCardModel.statusWords[status]
            canStop = status == "running" || status == "queued"
        }
        // Its run step: while open, what the repository runs; an accepted Build that kept its copy, Open and Stop.
        let kept = final && status == "accepted" && task["keptCopy"]?.bool == true
        if let step, !step.isNull, step["status"]?.string != "skipped", !(final && !kept) {
            let w = step["status"]?.string == "running"
            runWorking = w && !kept
            runFailed = step["status"]?.string == "failed" && !kept
            runLabel = kept ? "Running on what landed" : w ? "Getting it running…" : "Run step"
            let list = step["runnables"]?.array ?? []
            runNote = kept ? "" : w ? (step["phase"]?.string ?? "Working") : step["status"]?.string == "failed" ? (step["error"]?.string ?? "Failed")
                : step["status"]?.string == "stopped" ? "Stopped" : list.isEmpty ? "Nothing here to run" : "Preview opens what runs"
            if w && !kept { runActions = [Action(act: "buildrunstop", label: "Stop", style: "text")] }
            if kept { runActions = [Action(act: "buildrunstopall", label: "Stop all", style: "text")] }
            let kinds = ["ui": "web UI", "app": "desktop app", "terminal": "terminal"]
            runRows = list.filter { !kept || $0["passed"]?.bool == true || $0["status"]?.string == "running" }.map { item in
                let runs = item["status"]?.string == "running"
                let type = item["type"]?.string ?? ""
                let name = item["name"]?.string ?? ""
                var state = ["failed": "did not run", "stopped": "stopped", "installing": "installing", "checking": "checking"][item["status"]?.string ?? ""] ?? "waiting"
                if runs { state = type == "app" ? "runs in its window" : item["url"]?.string.map { "runs at \($0)" } ?? "runs" }
                let error = item["status"]?.string == "failed" ? item["error"]?.string?.components(separatedBy: "\n").first : nil
                let acts = kept && runs ? [Action(act: "buildrunshow", label: type == "ui" ? "Open" : type == "app" ? "Window" : "Terminal", style: "text", run: name),
                                           Action(act: "buildrunstopone", label: "Stop", style: "text", run: name)] : []
                return RunRow(name: name, kind: kinds[type] ?? type, state: state, tone: runs ? "green" : item["status"]?.string == "failed" ? "red" : "grey", error: error, actions: acts)
            }
        }
        // The reply field: a reply sent while a turn runs reaches the agent at once (2026-09-27).
        if !final && status != "accepting" { replyPlaceholder = status == "needs-you" ? "Answer…" : "Reply…" }
        // Preview on the left, Reject and Accept on the right (2026-09-29).
        if !working && !final {
            actions.append(Action(act: "buildpreview", label: "Preview", style: "box", disabled: stepping, title: stepping ? "Getting it running…" : ""))
            if ["interrupted", "stopped", "failed"].contains(status) { actions.append(Action(act: "buildresume", label: "Resume", style: "text")) }
            actions.append(Action(act: "buildreject", label: "Reject", style: "box"))
            actions.append(Action(act: "buildaccept", label: "Accept", style: "primary", disabled: stepping, title: stepping ? "Getting it running…" : ""))
        } else if final {
            if status == "accepted" && task["accepted"].map({ !$0.isNull }) == true { actions.append(Action(act: "buildreview", label: "Review", style: "text")) }
            if task["keptCopy"]?.bool != true { actions.append(Action(act: "buildremove", label: "Remove", style: "text")) } // what still runs is stopped first
        }
        // The error in red, unless the conversation's last note already says it.
        if let error = task["error"]?.string, !error.isEmpty, !final, !(all.last?["text"]?.string ?? "").contains(error) { errorLine = error }
    }
}
