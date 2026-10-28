import Foundation
import EngelbartCore

// Port of src/main/connect/fake.cjs: Connect's agents without a model (ENGELBART_CONNECT_FAKE=1, or ENGELBART_BART_FAKE=1),
// for scripted runs and tests. The librarian offers the button an app still needs, waits for a survey when nothing else is
// left, and asks one question per picked source; a survey reports three items; a recall saves a short profile; an import
// brings in a few notes from the vault, a few Claude Code chats or one note per web app through the real tools; the memory
// agent drafts MEMORY.md with two planted secrets and the secrets check takes out one of them.
// ENGELBART_CONNECT_FAKE_NEEDS=<app> makes that app's survey ask the person to sign in.
// What it reads of the session comes in AgentMeta.info: choices, found, message, homeDir, picked (folders), job
// ({ source, apps, label, find }), browserName, digest, evidence.

/// The fake librarian's memory between turns (fake.cjs s.fakeState), kept on the session.
public final class FakeInterviewState: @unchecked Sendable {
    public var asked: [(source: String, label: String, answered: String?)] = []
    public var offered: [String] = []
    public init() {}
}

public final class FakeAgents: ConnectAgents, @unchecked Sendable {
    static let labels = ["notes": "Notes", "transcripts": "Meeting transcripts", "email": "Email", "chats": "AI chats", "sites": "Websites", "papers": "Papers", "code": "Code"]
    let delayMs: Double
    let env: [String: String]
    public init(delayMs: Double = 600, env: [String: String] = ProcessInfo.processInfo.environment) { self.delayMs = delayMs; self.env = env }

    func sleep(_ ms: Double, _ signal: AbortSignal?) async throws {
        await waitFor(ms, signal)
        if signal?.isAborted == true { throw ConnectError.stopped() }
    }

    var needsApps: [String] { (env["ENGELBART_CONNECT_FAKE_NEEDS"] ?? "").components(separatedBy: ",") }

    public static let memoryDraftHead = "# Memory\n\nA researcher who studies help-seeking in novice programmers [stated].\n\n## Research\n- Why novices skip tests [stated].\n\n## Where their work lives\n- Obsidian notes; Claude Code sessions.\n\npassword: hunter2\nTheir OpenAI key, sk-test-0123456789abcdefghij, was pasted in a chat.\n\n## Sources\n- The fake recall, "
    public static var memoryDraft: String { memoryDraftHead + String(Time.iso().prefix(10)) + "." }

    public static let sampleProjects: [JSONValue] = [
        ["title": "Engelbart context import", "description": "Designing how agents bring project context into a local library.", "recent": "Today"],
        ["title": "Programming requirements study", "description": "Studying how novice programmers describe and test requirements.", "recent": "Yesterday"],
        ["title": "Learning sciences reading guide", "description": "Organizing research on learning, agency and programming.", "recent": "This week"],
        ["title": "Engelbart launch", "description": "Preparing onboarding, outreach and the first user sessions.", "recent": "This week"],
    ]

    /// fake.cjs interviewReply.
    public static func interviewReply(state: FakeInterviewState, choices: JSONValue, found: JSONValue, message: String) -> JSONValue {
        var dispatch: [JSONValue] = []
        if let last = state.asked.indices.last, state.asked[last].answered == nil, message != "Start.", !JS.test(message, "^(authorized|signed in|allowed|chose|survey finished)") {
            state.asked[last].answered = message
            if !JS.test(message, "Leave it out|skipped") {
                dispatch.append(["source": .string(state.asked[last].source), "apps": [], "label": .string(state.asked[last].label), "plan": .string("Fake import of \(state.asked[last].label): \(message)")])
            }
        }
        var waitFor: String?
        for source in ConnectSources.sourceIds {
            guard let choice = choices["sources"]?[source], JS.truthy(choice["on"]), !state.asked.contains(where: { $0.source == source }) else { continue }
            let apps = choice["apps"]?.array?.compactMap(\.string) ?? []
            let foundHere = found[source]
            if let needs = apps.first(where: { JS.truthy(foundHere?[$0]?["needs"]) && !state.offered.contains($0) }) {
                state.offered.append(needs)
                let kind = JS.string(foundHere?[needs]?["needs"])
                let label = kind == "connector" || kind == "signin" ? "Sign in to \(needs)" : kind == "permission" ? "Allow Engelbart to read \(needs)" : "Choose your \(needs) folder…"
                return ["say": .string("\(needs) needs a step from you first."), "ask": .null, "authorize": ["source": .string(source), "app": .string(needs), "kind": .string(kind), "label": .string(label)],
                        "dispatch": .array(dispatch), "waiting": false, "done": false]
            }
            if apps.contains(where: { foundHere?[$0]?["survey"]?.string == "running" || JS.truthy(foundHere?[$0]?["consent"]) }) { waitFor = waitFor ?? source; continue }
            let label = labels[source] ?? source
            let surveyed = apps.compactMap { foundHere?[$0]?["survey"]?["items"]?.array }.first { !$0.isEmpty }
            state.asked.append((source, label, nil))
            let options: [JSONValue]
            if let surveyed {
                options = surveyed.enumerated().map { i, item in
                    var o: [String: JSONValue] = ["label": item["label"] ?? "", "why": .string(JS.string(item["why"])), "checked": .bool(i == 0)]
                    if i == 0 { o["detail"] = .string([item["label"], item["kind"], item["date"], item["where"]].compactMap { $0 }.map { JS.string($0) }.filter { !$0.isEmpty }.joined(separator: " · ")) }
                    return .object(o)
                }
            } else {
                options = [["label": "Everything", "why": "all of it"], ["label": "Only the last 30 days", "why": ""], ["label": "Leave it out", "why": ""]]
            }
            let say = dispatch.isEmpty ? "Let me check a few things." : "Bringing in \(JS.string(dispatch[0]["label"])) now."
            return ["say": .string(say), "ask": ["source": .string(source), "kind": .string(surveyed != nil ? "multi" : "single"), "title": .string("What from \(label.lowercased())?"), "options": .array(options)],
                    "authorize": .null, "dispatch": .array(dispatch), "waiting": false, "done": false]
        }
        if let waitFor {
            let lead = dispatch.isEmpty ? "" : "Bringing in \(JS.string(dispatch[0]["label"])) now. "
            return ["say": .string("\(lead)Looking through your \((labels[waitFor] ?? waitFor).lowercased()) now."), "ask": .null, "authorize": .null, "dispatch": .array(dispatch), "waiting": true, "done": false]
        }
        return ["say": .string(dispatch.isEmpty ? "That's everything." : "Bringing in \(JS.string(dispatch[0]["label"])) now. That's everything."), "ask": .null, "authorize": .null, "dispatch": .array(dispatch), "waiting": false, "done": true]
    }

    /// The folders under `home`, breadth first, Library and hidden folders passed over, a few levels down.
    static func foldersUnder(_ home: String, depth: Int = 5, readable: ((String) -> Bool)? = nil) -> [String] {
        var out: [String] = []
        var level = [home]
        for _ in 0..<depth where !level.isEmpty {
            var next: [String] = []
            for dir in level {
                for entry in (Readers.entries(dir) ?? []).sorted(by: { $0.name < $1.name }) where entry.isDir && !entry.name.hasPrefix(".") && entry.name != "Library" && entry.name != "node_modules" {
                    let full = (dir as NSString).appendingPathComponent(entry.name)
                    if let readable, !readable(full) { continue }
                    out.append(full); next.append(full)
                }
            }
            level = next
        }
        return out
    }

    static func findRun(homeDir: String, app: String) -> JSONValue {
        let all = foldersUnder(homeDir)
        let searched: JSONValue = "every folder of the home folder but Library and the hidden ones"
        let entries = { (dir: String) in Readers.entries(dir) ?? [] }
        if app == ConnectSources.localPDFs {
            let folders = all.filter { dir in entries(dir).contains { $0.isFile && JS.test($0.name, #"\.pdf$"#, options: .caseInsensitive) } }
            return ["app": .string(app), "signedIn": true, "summary": .string(folders.isEmpty ? "No PDFs found." : "PDFs in \(folders.count) folders."), "items": [], "folders": .array(folders.map { .string($0) }), "searched": searched]
        }
        let folder = app == "Obsidian"
            ? all.first { dir in entries(dir).contains { $0.isDir && $0.name == ".obsidian" } }
            : all.first { dir in JS.test((dir as NSString).lastPathComponent, "^zoom$", options: .caseInsensitive) && entries(dir).contains { e in e.isDir && entries((dir as NSString).appendingPathComponent(e.name)).contains { $0.isFile && JS.test($0.name, #"\.(vtt|txt)$"#, options: .caseInsensitive) } } }
        let shown = ConnectSources.shownName(app)
        return ["app": .string(app), "signedIn": true, "summary": .string(folder != nil ? "Found the \(shown) folder." : "No \(shown) folder found."), "items": [], "folder": folder.map { .string($0) } ?? .null,
                "searched": searched, "notes": folder == nil && app == "Zoom" ? "No recordings on this Mac; cloud recordings at zoom.us/recording." : .null]
    }

    func callTool(_ meta: AgentMeta, _ name: String, _ args: JSONValue) async throws -> JSONValue {
        guard let call = meta.callTool else { throw ConnectError("failed", "No tools") }
        return try await call(name, args)
    }

    func surveyRun(_ input: AgentTurnInput) async throws -> String {
        let job = input.meta.info["job"] ?? .null
        let app = JS.string(job["apps"]?[0])
        try await sleep(delayMs, input.signal)
        if job["find"] == .bool(true) { return Self.findRun(homeDir: JS.string(input.meta.info["homeDir"]), app: app).text() }
        let shown = ConnectSources.shownName(app)
        if needsApps.contains(app) {
            var out = try await callTool(input.meta, "needs_you", ["kind": "signin", "reason": .string("Sign in to \(shown)")])
            var n = 0
            while n < 10 && out["status"]?.string == "waiting" { out = try await callTool(input.meta, "wait_for_you", .object([:])); n += 1 }
            if out["status"]?.string == "skipped" { return JSONValue.object(["app": .string(app), "signedIn": false, "summary": .string("\(shown) was skipped."), "items": []]).text() }
        }
        let slug = JS.replace(app.lowercased(), #"\W+"#, "-")
        return JSONValue.object(["app": .string(app), "signedIn": true, "summary": .string("3 things in \(shown)."), "total": 3, "items": .array((1...3).map { n in
            ["id": .string("\(slug)-\(n)"), "label": .string("\(shown) item \(n)"), "kind": "doc", "date": .string("2026-10-0\(n)"), "where": .null, "why": n == 1 ? "research" : .null]
        })]).text()
    }

    func importRun(_ input: AgentTurnInput) async throws -> String {
        let info = input.meta.info
        let job = info["job"] ?? .null
        let source = JS.string(job["source"])
        let apps = job["apps"]?.array?.compactMap(\.string) ?? []
        let choices = info["choices"] ?? .null
        try await sleep(delayMs, input.signal)
        if source == "notes" && (apps.isEmpty || apps.contains("Obsidian")) {
            let vaults = Readers.obsidianVaults(JS.string(info["homeDir"]))
            let folder = info["picked"]?["Obsidian"]?.string ?? choices["sources"]?["notes"]?["folders"]?[0]?.string ?? vaults.first?.path
            if let folder {
                let listed = try await callTool(input.meta, "list_note_files", ["folder": .string(folder)])
                try await sleep(delayMs, input.signal)
                let out = try await callTool(input.meta, "import_note_files", ["files": .array(Array((listed["files"]?.array ?? []).prefix(5))), "root": .string(folder)])
                return "Brought in \(JS.string(out["added"])) notes."
            }
        }
        if source == "chats", (choices["sources"]?["chats"]?["apps"]?.array?.compactMap(\.string) ?? []).contains("Claude Code"), apps.isEmpty || apps.contains("Claude Code") {
            let chats = try await callTool(input.meta, "list_chats", ["app": "Claude Code", "limit": 3])
            let out = try await callTool(input.meta, "import_chats", ["app": "Claude Code", "ids": .array((chats.array ?? []).map { $0["id"] ?? .null })])
            return "Brought in \(JS.string(out["added"])) chats."
        }
        let web = (apps.isEmpty ? (choices["sources"]?[source]?["apps"]?.array?.compactMap(\.string) ?? []) : apps).filter { $0 != "Obsidian" && $0 != "Claude Code" }
        var n = 0
        for app in web {
            let shown = ConnectSources.shownName(app)
            let out = try await callTool(input.meta, "add_note", ["title": .string("\(shown): fake note"), "markdown": .string("A note the fake agent brought in from \(shown)."), "source": .string("fake:\(app)")])
            if out["added"] == .bool(true) { n += 1 }
        }
        try await sleep(delayMs, input.signal)
        return n > 0 ? "Brought in \(n) notes." : "Nothing to bring in from the fake agent."
    }

    func browseRun(_ input: AgentTurnInput) async throws -> String {
        let job = input.meta.info["job"] ?? .null
        let given = job["apps"]?.array?.compactMap(\.string) ?? []
        let apps = given.isEmpty ? ["Other tools"] : given
        let browserName = input.meta.info["browserName"]?.string ?? "Chrome"
        input.onUpdate(AgentUpdate(command: "fake browser agent in \(browserName)"))
        var n = 0
        for app in apps {
            let shown = ConnectSources.shownName(app)
            input.onUpdate(AgentUpdate(activity: "Opening \(shown) in a tab of its own"))
            try await sleep(delayMs, input.signal)
            if needsApps.contains(app) {
                var out = try await callTool(input.meta, "needs_you", ["kind": "signin", "reason": .string("Sign in to \(shown) in \(browserName)")])
                var k = 0
                while k < 10 && out["status"]?.string == "waiting" { out = try await callTool(input.meta, "wait_for_you", .object([:])); k += 1 }
                if out["status"]?.string == "skipped" { continue }
            }
            input.onUpdate(AgentUpdate(activity: "Reading the page"))
            let out = try await callTool(input.meta, "add_note", ["title": .string("\(shown): a page read in \(browserName)"), "markdown": .string("A page the fake browser agent read in \(shown)."), "source": .string("fake-browser:\(app)")])
            if out["added"] == .bool(true) { n += 1 }
        }
        try await sleep(delayMs, input.signal)
        return n > 0 ? "Brought in \(n) pages from \(browserName)." : "Nothing brought in from \(browserName)."
    }

    func recallRun(_ input: AgentTurnInput) async throws -> String {
        try await sleep(delayMs, input.signal)
        let app = JS.string(input.meta.info["job"]?["apps"]?[0])
        _ = try await callTool(input.meta, "save_memory", ["app": .string(app), "text": .string("# Research profile\n\nStudies how novices ask for help [stated]. Works with \(app) on study design [inferred].")])
        return "Saved \(app)'s answer."
    }

    static func fakeProjects(_ digest: JSONValue?) -> JSONValue {
        let found: [JSONValue] = (digest?["folders"]?.array ?? []).prefix(3).map { f in
            ["title": f["name"] ?? "", "description": .string("Recent work in \(JS.string(f["shown"])).") , "recent": "This week", "folder": f["path"] ?? "", "evidence": .string("\(JS.string(f["sessions"])) agent sessions")]
        }
        return ["projects": .array(Array((found + sampleProjects).prefix(4)))]
    }

    static func fakeTools(_ evidence: JSONValue?) -> JSONValue {
        let tools: [JSONValue] = (evidence?.object ?? [:]).sorted { $0.key < $1.key }.map { id, fact in ["id": .string(id), "used": .bool(JS.truthy(fact["used"])), "evidence": .string(JS.string(fact["evidence"]))] }
        return ["tools": .array(tools), "additional": [["name": "Linear", "website": "https://linear.app", "used": true, "evidence": "Visited often in the sample history"]]]
    }

    public func turn(_ input: AgentTurnInput) async throws -> AgentTurnOutput {
        let what = input.meta.kind.isEmpty ? input.kind : input.meta.kind
        switch what {
        case "browse": return AgentTurnOutput(text: try await browseRun(input), session: nil)
        case "survey": return AgentTurnOutput(text: try await surveyRun(input), session: nil)
        case "import": return AgentTurnOutput(text: try await importRun(input), session: nil)
        case "recall": return AgentTurnOutput(text: try await recallRun(input), session: nil)
        case "memory": try await sleep(delayMs, input.signal); return AgentTurnOutput(text: Self.memoryDraft, session: nil)
        case "redact":
            try await sleep(delayMs, input.signal)
            let draft = JS.replace(input.message, "^<memory_md>\n|\n</memory_md>$", "")
            return AgentTurnOutput(text: draft.replacingOccurrences(of: "password: hunter2", with: "password: [removed]"), session: nil)
        case "projects": try await sleep(delayMs * 2, input.signal); return AgentTurnOutput(text: Self.fakeProjects(input.meta.info["digest"]).text(), session: nil)
        case "discover": try await sleep(delayMs * 2, input.signal); return AgentTurnOutput(text: Self.fakeTools(input.meta.info["evidence"]).text(), session: nil)
        default:
            try await sleep(delayMs, input.signal)
            let state = input.meta.fakeState ?? FakeInterviewState()
            return AgentTurnOutput(text: Self.interviewReply(state: state, choices: input.meta.info["choices"] ?? .null, found: input.meta.info["found"] ?? .null,
                                                             message: JS.string(input.meta.info["message"])).text(), session: "fake-session")
        }
    }
}

/// fake.cjs createCliGatedAgents (ENGELBART_CONNECT_FAKE_CLI): a turn fails as the real CLI's does when the pretend
/// machine's CLI is missing or not signed in. `state(cli)` → (present, broken, signedIn) from the tools fake.
public final class CliGatedAgents: ConnectAgents, @unchecked Sendable {
    let agents: ConnectAgents
    let state: (String) -> (present: Bool, broken: Bool, signedIn: Bool?)
    let delayMs: Double
    let refuse: [String]
    public init(_ agents: ConnectAgents, state: @escaping (String) -> (present: Bool, broken: Bool, signedIn: Bool?), delayMs: Double = 60, refuse: [String] = []) {
        self.agents = agents; self.state = state; self.delayMs = delayMs; self.refuse = refuse
    }
    public func turn(_ input: AgentTurnInput) async throws -> AgentTurnOutput {
        let cli = input.choice.provider == "openai" ? "codex" : "claude"
        let tool = state(cli)
        await waitFor(delayMs, input.signal)
        if input.signal?.isAborted == true { throw ConnectError.stopped() }
        if !tool.present || tool.broken { throw ConnectError("unavailable", "\(cli == "codex" ? "Codex" : "Claude Code") was not found on the login shell PATH.") }
        if tool.signedIn != true {
            if cli == "codex" { throw ConnectError("unavailable", "Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used.") }
            throw ConnectError("failed", "Not logged in · Please run /login")
        }
        if refuse.contains(cli) { throw ConnectError("failed", "Credit balance is too low") }
        return try await agents.turn(input)
    }
}
