import Foundation
import EngelbartCore
import EngelbartConnect

// The words of the popups an Import your context run puts over the workspace: a step for the person
// (src/renderer/import/NeedPopup.jsx needCopy), Connect Claude Code / Codex (ProviderPopup.jsx cliReady, providerCopy) and
// Imports in progress (ImportStatus.jsx jobState, nothingLines, needWords, its rows and its completion list).

// MARK: NeedPopup.jsx

/// A step's words → title, text, primary, secondary (the quiet link), waiting (the primary disabled).
public struct NeedCopy: Equatable, Sendable {
    public var title: String
    public var text: String
    public var primary: String
    public var secondary: String
    public var waiting: Bool
    public init(title: String, text: String = "", primary: String, secondary: String, waiting: Bool = false) {
        self.title = title; self.text = text; self.primary = primary; self.secondary = secondary; self.waiting = waiting
    }
}

public enum NeedPopupModel {
    /// One at a time, over whatever is showing (round 3, 2026-10-13). Nothing signs in inside Engelbart but Engelbart's own
    /// sign-ins; Skip (it said Later until From Amitav, 2026-10-15) leaves that app out of the run. No "Continue in
    /// {browser}." under any of them: the button says where it goes.
    public static func needCopy(_ need: JSONValue) -> NeedCopy {
        let rawApp = J.str(need["app"])
        let app = ConnectSources.shownName(rawApp)
        let browser = J.str(need["browser"]).isEmpty ? "your browser" : J.str(need["browser"])
        let kind = J.str(need["kind"])
        let opened = J.truthy(need["opened"]), busy = J.truthy(need["busy"])
        // GitHub and Zotero sign in through Engelbart's own sign-in, in the person's default browser.
        if rawApp == "GitHub" || rawApp == "Zotero" {
            if busy { return NeedCopy(title: "Sign in to \(app)", primary: "Opening…", secondary: "Skip", waiting: true) }
            if opened {
                let code = J.str(need["code"])
                return NeedCopy(title: "Sign in to \(app)", text: code.isEmpty ? "Finish signing in in your browser." : "Enter \(code) on GitHub, then come back.", primary: "Open again", secondary: "Skip")
            }
            return NeedCopy(title: "Sign in to \(app)", primary: "Sign in", secondary: "Skip")
        }
        // A sign-in brought back (connect/session.cjs recover, 2026-10-16): Sign in inside Engelbart or Skip.
        if kind == "signin-here" {
            if busy { return NeedCopy(title: "Sign in to \(app)", primary: "Waiting…", secondary: "Skip", waiting: true) }
            return NeedCopy(title: "Sign in to \(app)", primary: J.str(need["where"]) == "browser" ? "Sign in in \(browser)" : "Sign in inside Engelbart", secondary: "Skip")
        }
        if kind == "permission" { return NeedCopy(title: "Allow Engelbart to read \(app)?", primary: "Allow", secondary: "Don’t allow") }
        if kind == "folder" { return NeedCopy(title: "Choose your \(app) folder", primary: "Choose folder", secondary: "Skip") }
        // A connector's sign-in opens in the default browser, whichever browser was chosen for the copies.
        if kind == "connector" {
            return NeedCopy(title: "Connect \(app)", text: busy ? "Finish connecting in your browser." : "", primary: busy ? "Waiting…" : "Connect", secondary: "Skip", waiting: busy)
        }
        if kind == "confirm" {
            let reason = J.str(need["reason"]).isEmpty ? "Finish this in \(app)" : J.str(need["reason"])
            return NeedCopy(title: reason.hasSuffix(".") ? String(reason.dropLast()) : reason, primary: "Done", secondary: "Skip")
        }
        if kind == "code" || kind == "2fa" { return NeedCopy(title: "Enter the code for \(app)", primary: opened ? "Done" : "Open \(browser)", secondary: "Skip") }
        if kind == "captcha" { return NeedCopy(title: "Finish the check for \(app)", primary: opened ? "Done" : "Open \(browser)", secondary: "Skip") }
        return NeedCopy(title: "Sign in to \(app)", primary: opened ? "I’m signed in" : "Open \(browser)", secondary: "Skip")
    }

    /// "I'm signed in" / Done: only for a step the person finishes themselves. Zotero's, GitHub's and a connector's close by
    /// themselves once signed in, so their button opens the sign-in (again).
    public static func finishing(_ need: JSONValue) -> Bool {
        let app = J.str(need["app"]), kind = J.str(need["kind"])
        let own = app == "GitHub" || app == "Zotero"
        return J.truthy(need["opened"]) && !own && !["connector", "permission", "folder", "confirm"].contains(kind)
    }
}

// MARK: ProviderPopup.jsx

public struct ProviderCopy: Equatable, Sendable {
    public var state: String
    public var line: String
    public var primary: String
    public var waiting: Bool
    public var problem: Bool
}

public enum ProviderPopupModel {
    public static let cli = ["anthropic": "claude", "openai": "codex"]
    public static let name = ["anthropic": "Claude Code", "openai": "Codex"]

    /// A CLI's record → whether it can run: installed, working, signed in by its own word.
    public static func cliReady(_ tool: JSONValue?) -> Bool {
        guard let tool, J.truthy(tool) else { return false }
        let status = J.str(tool["status"])
        return J.truthy(tool["installed"]) && J.isTrue(tool["signedIn"]) && (status == "ready" || status == "updating" || (status == "outdated" && J.truthy(tool["autoUpdate"])))
    }

    /// What the popup says for the blocked provider's CLI record. `changed`: the popup has seen it not ready since it opened.
    public static func providerCopy(_ provider: String, _ tool: JSONValue?, why: String = "", changed: Bool = false) -> ProviderCopy {
        let named = name[provider] ?? "Claude Code"
        let busy = tool?["busy"].flatMap(J.present)
        if cliReady(tool) && !(busy.map { J.str($0["action"]) == "sign-in" } ?? false) {
            if changed { return ProviderCopy(state: "ready", line: "Connected. Your imports are starting again.", primary: "Connected", waiting: true, problem: false) }
            return ProviderCopy(state: "refused", line: why.isEmpty ? "\(named) couldn’t run your imports." : String(why.prefix(160)), primary: "Sign in again", waiting: false, problem: true)
        }
        if let busy, J.str(busy["action"]) == "sign-in" {
            let url = J.str(busy["url"])
            return ProviderCopy(state: "signing-in", line: "Finish signing in in your browser.", primary: url.isEmpty ? "Waiting…" : "Open page", waiting: url.isEmpty, problem: false)
        }
        let status = J.str(tool?["status"])
        if (busy != nil && J.str(busy?["action"]) != "sign-out") || (tool != nil && ["installing", "checking", "unknown", "updating"].contains(status)) {
            return ProviderCopy(state: "connecting", line: "Connecting \(named)…", primary: "Connecting…", waiting: true, problem: false)
        }
        let problem = tool?["error"]?.string.map { firstSentence($0, max: 160) } ?? ""
        // No line under the title unless something went wrong (From Amitav, 2026-10-15: no subtext on these prompts).
        return ProviderCopy(state: "not-connected", line: problem, primary: "Connect", waiting: false, problem: !problem.isEmpty)
    }
}

// MARK: ImportStatus.jsx

public struct StatusRow: Equatable, Sendable {
    public var id: String
    public var apps: [String]
    public var name: String
    public var state: String
    /// The step a waiting row opens again ("Needs you"), when it has one.
    public var needId: String?
    public var error: String?
}

public struct CompletionRow: Equatable, Sendable {
    /// The logo file the row is drawn with, 'web' or 'folder'.
    public var key: String
    public var name: String
}

public enum ImportStatusModel {
    static let ended: Set<String> = ["done", "failed", "stopped"]
    static let work: Set<String> = ["import", "recall", "survey"]
    static let rank = ["waiting": 0, "running": 1, "queued": 2]

    /// A row's name: the app ("Obsidian", "Google Drive"), not the job's "Notes: Obsidian".
    public static func rowName(_ job: JSONValue) -> String {
        let apps = J.strs(job["apps"])
        if apps.count == 1 { return ImportFlow.catalogTool(apps[0])?.name ?? ConnectSources.shownName(apps[0]) }
        return J.str(job["label"]).replacingOccurrences(of: #"^[^:]{1,30}:\s*"#, with: "", options: .regularExpression)
    }

    /// Whether a job brought anything into the library.
    static func brought(_ job: JSONValue) -> Bool { J.str(job["status"]) == "done" && J.int(job["notes"]) + J.int(job["items"]) > 0 }

    /// A job's state in the list's last column.
    public static func jobState(_ job: JSONValue) -> String {
        if J.truthy(job["skipped"]) { return "Left out" }
        let n = J.int(job["notes"]) + J.int(job["items"])
        switch J.str(job["status"]) {
        case "waiting": return "Needs you"
        case "running": return n > 0 ? "\(n) added" : "Working"
        case "queued": return "Queued"
        case "done": return n > 0 ? "Done · \(n)" : "Done"
        // A failed import is not one the person left out (2026-10-14: Granola's "model at capacity" read as "Left out").
        case "failed": return "Couldn’t import"
        case "stopped": return "Stopped"
        default: return "Left out"
        }
    }

    /// A reason's first sentence, without its full stop, at most `max` characters (an ellipsis when cut).
    static func sentence(_ text: String, max: Int = 140) -> String {
        let flat = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        var one = flat
        if let range = flat.range(of: #"(?<=[.!?])\s"#, options: .regularExpression) { one = String(flat[..<range.lowerBound]) }
        one = one.replacingOccurrences(of: #"[.!?]+$"#, with: "", options: .regularExpression)
        return one.count > max ? String(one.prefix(max - 1)) + "…" : one
    }

    /// Why each source that ended brought nothing in (2026-10-14), one line each.
    public static func nothingLines(_ session: JSONValue, jobs: [JSONValue], imported: [JSONValue]) -> [(name: String, line: String)] {
        let leftOut = J.arr(session["leftOut"])
        func whyOf(_ apps: [String]) -> String { J.str(leftOut.first { apps.contains(J.str($0["app"])) }?["why"]) }
        var out: [(String, String)] = []
        func add(_ name: String, _ line: String) {
            if !name.isEmpty && !out.contains(where: { $0.0 == name }) && !imported.contains(where: { rowName($0) == name }) { out.append((name, line)) }
        }
        for job in jobs where !brought(job) && ended.contains(J.str(job["status"])) {
            let name = rowName(job)
            let why = whyOf(J.strs(job["apps"]))
            let error = J.str(job["error"]), summary = J.str(job["summary"])
            if !why.isEmpty { add(name, "Nothing came in from \(name): \(why).") }
            else if J.str(job["status"]) == "failed" { add(name, "Nothing came in from \(name): its import failed\(error.isEmpty ? "" : " (\(sentence(error, max: 100)))").") }
            else if J.str(job["status"]) == "stopped" { add(name, "Nothing came in from \(name): it was stopped.") }
            else if !summary.isEmpty { add(name, "Nothing came in from \(name). \(sentence(summary)).") }
            else { add(name, "Nothing came in from \(name).") }
        }
        for entry in leftOut {
            let app = J.str(entry["app"])
            if jobs.contains(where: { J.strs($0["apps"]).contains(app) }) { continue }
            let name = ImportFlow.catalogTool(app)?.name ?? ConnectSources.shownName(app)
            add(name, "Nothing came in from \(name): \(J.str(entry["why"])).")
        }
        return out.map { (name: $0.0, line: $0.1) }
    }

    /// A card's words: what the app needs, and its button.
    public static func needWords(_ need: JSONValue) -> (title: String, button: String, done: Bool) {
        let app = ConnectSources.shownName(J.str(need["app"]))
        let kind = J.str(need["kind"]), browser = J.str(need["browser"])
        if J.truthy(need["own"]) {
            let title = kind == "2fa" || kind == "code" ? "\(app) needs a code in \(browser)" : kind == "captcha" ? "\(app) needs you to answer a check in \(browser)" : "Sign in to \(app) in \(browser)"
            return (title, J.truthy(need["opened"]) ? "Done" : "Open \(browser)", J.truthy(need["opened"]))
        }
        let title = kind == "permission" ? "\(app) needs permission" : kind == "folder" ? "\(app) needs its folder" : kind == "code" || kind == "2fa" ? "\(app) needs a code" : kind == "connector" ? "\(app) needs you to connect it" : "\(app) needs you to sign in"
        let button = kind == "permission" ? "Allow" : kind == "folder" ? "Choose folder" : kind == "code" || kind == "2fa" ? "Open" : J.truthy(need["busy"]) ? "Open page" : "Log in"
        return (title, button, false)
    }

    /// The jobs the list shows: imports and surveys (not recalls), those that need the person first, then working, queued
    /// and ended (a stable sort).
    public static func jobs(_ session: JSONValue) -> [JSONValue] {
        J.arr(session["jobs"]).filter { work.contains(J.str($0["kind"])) && J.str($0["kind"]) != "recall" }
            .enumerated().sorted { a, b in
                let ra = rank[J.str(a.element["status"])] ?? 3, rb = rank[J.str(b.element["status"])] ?? 3
                return ra != rb ? ra < rb : a.offset < b.offset
            }.map(\.element)
    }

    /// Apps left out before an import of theirs started (Skip on a sign-in held at the start): a row each, "Left out".
    static func leftOnly(_ session: JSONValue, _ jobs: [JSONValue]) -> [JSONValue] {
        J.arr(session["leftOut"]).filter { entry in
            let app = J.str(entry["app"])
            return !jobs.contains { J.strs($0["apps"]).contains(app) } && !J.arr(session["needs"]).contains { J.str($0["app"]) == app }
        }.map { entry -> JSONValue in
            let app = J.str(entry["app"])
            return ["id": .string("left-\(app)"), "kind": "import", "apps": [.string(app)], "label": .string(app), "status": "stopped", "skipped": true]
        }
    }

    /// Ended: every job done, failed or stopped, no step waiting and nothing held on a sign-in; a run with nothing to run
    /// at all (every app left out) once it finished and is not thinking.
    public static func isEnded(_ session: JSONValue) -> Bool {
        let jobs = jobs(session)
        let left = leftOnly(session, jobs)
        let some = !jobs.isEmpty || (!left.isEmpty && J.truthy(session["finished"]) && !J.truthy(session["thinking"]))
        return some && jobs.allSatisfy { ended.contains(J.str($0["status"])) } && J.arr(session["needs"]).isEmpty && !J.truthy(session["holding"])
    }

    /// The step a job is waiting on: by its need id, else one that names the job, else one of its app.
    static func needOf(_ session: JSONValue, _ job: JSONValue) -> JSONValue? {
        let needs = J.arr(session["needs"])
        if let needId = job["needId"]?.string { return needs.first { J.str($0["id"]) == needId } }
        return needs.first { need in J.strs(need["jobIds"]).contains(J.str(job["id"])) || J.strs(job["apps"]).contains(J.str(need["app"])) }
    }

    /// The running list: apps held on a sign-in (their import starts once signed in) first, then the jobs, then the apps
    /// left out before they ran.
    public static func rows(_ session: JSONValue) -> [StatusRow] {
        let jobs = jobs(session)
        let held: [JSONValue] = J.arr(session["needs"]).filter { need in
            J.strs(need["jobIds"]).isEmpty && !jobs.contains { J.strs($0["apps"]).contains(J.str(need["app"])) }
        }.map { need in
            ["id": .string("need-\(J.str(need["id"]))"), "needId": need["id"] ?? .null, "kind": "import", "apps": [need["app"] ?? ""], "label": need["app"] ?? "", "status": "waiting"]
        }
        return (held + jobs + leftOnly(session, jobs)).map { job in
            let need = J.str(job["status"]) == "waiting" ? needOf(session, job) : nil
            let error = J.str(job["status"]) == "failed" && J.truthy(job["error"]) ? String(J.str(job["error"]).prefix(300)) : nil
            return StatusRow(id: J.str(job["id"]), apps: J.strs(job["apps"]), name: rowName(job), state: jobState(job), needId: need.map { J.str($0["id"]) }, error: error)
        }
    }

    public struct Ended: Equatable, Sendable {
        public var title: String
        public var body: String
        public var rows: [CompletionRow]
    }

    /// The modal once everything ended: "Your imports are complete!" when every source brought something in and nothing
    /// was left out; else "Your imports have finished"; what came in as a list, one row a logo (2026-10-15: "no duplicate
    /// globe icons or claude"), and nothing about what did not ("no one will read any of it").
    public static func ended(_ session: JSONValue) -> Ended? {
        guard isEnded(session) else { return nil }
        let jobs = jobs(session)
        let imported = jobs.filter(brought)
        let all = imported.count == jobs.count && leftOnly(session, jobs).isEmpty
        let body = all ? "All of the sources you have selected are now inside of your Engelbart Library." : !imported.isEmpty ? "These sources are now inside of your Engelbart Library." : "Nothing new came into your Engelbart Library."
        return Ended(title: all ? "Your imports are complete!" : "Your imports have finished", body: body, rows: completionRows(imported))
    }

    /// The rows of the completion list: each job that brought something in, by its logo.
    public static func completionRows(_ jobs: [JSONValue]) -> [CompletionRow] {
        var keys: [String] = []
        var names: [String: [String]] = [:]
        for job in jobs {
            let app = J.strs(job["apps"]).first
            let key = app.flatMap { Logos.toolFile($0) } ?? (app == nil || app == "__sites" ? "web" : "folder")
            if names[key] == nil { keys.append(key); names[key] = [] }
            let name = rowName(job)
            if !names[key]!.contains(name) { names[key]!.append(name) }
        }
        return keys.map { CompletionRow(key: $0, name: names[$0]!.joined(separator: ", ")) }
    }
}
