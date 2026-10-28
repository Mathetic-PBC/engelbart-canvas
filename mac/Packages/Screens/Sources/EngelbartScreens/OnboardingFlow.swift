import EngelbartCore
import EngelbartStore
import EngelbartTools
import Foundation

// Onboarding's order and gates (2026-09-28; Claude Design "Onboarding.dc.html" and Hudson's tweaks in
// design/onboarding/TWEAKS.md). Pure: OnboardingModel asks where Continue and Skip go. Port of
// src/renderer/model/onboarding.js, names kept so the two read side by side.

/// Onboarding's mode: a new person's first run, + Project ('existing'), or the guided setup inside a project.
public enum OnboardingMode: String, Sendable, CaseIterable {
    case new, existing, guided
}

/// A place in the flow: the step, its part (2a, 2b …) and whether the context screen sent the person out of the flow.
public struct OnboardingPlace: Equatable, Sendable {
    public var step: String
    public var sub: Int
    public var detour: Bool
    public init(step: String, sub: Int = 0, detour: Bool = false) { self.step = step; self.sub = sub; self.detour = detour }
}

/// flowOf's options: whether the tools screen and Connect your library are in the flow.
public struct FlowOptions: Equatable, Sendable {
    public var tools: Bool
    public var connect: Bool
    public init(tools: Bool = true, connect: Bool = false) { self.tools = tools; self.connect = connect }
}

/// Where the pager is: `count` dots, `index` the current one.
public struct PagerPosition: Equatable, Sendable {
    public var count: Int
    public var index: Int
    public init(count: Int, index: Int) { self.count = count; self.index = index }
}

/// The CLIs' providers as src/main/onboarding/providers.cjs reports them (`importApi.providers()`).
public struct AgentProviders: Equatable, Sendable {
    public struct Entry: Equatable, Sendable {
        public var id: String
        public var installed: Bool
        public var signedIn: Bool
        public var subscription: String?
        /// The CLI's own word on a subscription; nil from a main without it.
        public var subscribed: Bool?
        public init(id: String, installed: Bool = true, signedIn: Bool = false, subscription: String? = nil, subscribed: Bool? = nil) {
            self.id = id; self.installed = installed; self.signedIn = signedIn; self.subscription = subscription; self.subscribed = subscribed
        }
    }
    public var providers: [Entry]
    public var decision: String?
    public init(providers: [Entry], decision: String? = nil) { self.providers = providers; self.decision = decision }

    /// `{ providers: [{ id, installed, signedIn, subscription, subscribed }], decision }`; nil when `providers` is no list.
    public init?(json: JSONValue?) {
        guard let list = json?["providers"]?.array else { return nil }
        providers = list.compactMap { one in
            guard let id = one["id"]?.string else { return nil }
            let sub = one["subscription"]?.string
            return Entry(id: id, installed: one["installed"]?.bool ?? false, signedIn: one["signedIn"]?.bool ?? false,
                         subscription: sub?.isEmpty == true ? nil : sub, subscribed: one["subscribed"]?.bool)
        }
        decision = json?["decision"]?.string
    }
}

public enum OnboardingFlow {
    /**
     A new install walks all six screens; + Project on the all-projects screen only the last two. The tools screen
     (second, 2026-09-28: it replaces the setup dialog a first launch used to open) is left out when `tools` is false.
     Connect your library (2026-10-07) is in the flow when `connect` is true, and then it takes the place of Add to your
     library and Custom instructions. A new user's flow has no Project context screen (2026-10-09); + Project keeps
     create → context. Create comes before Connect (2026-10-10): the librarian is told what the project is. The project
     itself is made at the end of the flow ('open', see endOf). The intro screen (2026-10-11) was deleted (2026-10-12).
     */
    public static let FLOWS: [OnboardingMode: [String]] = [
        .new: ["welcome", "tools", "create", "connect", "import", "instructions"],
        .existing: ["create", "context"],
        .guided: ["welcome", "tools", "connect", "import", "instructions"],
    ]

    /// A new user's screens: Connect, the tools screen's agents (the guided setup is one too, 2026-10-10).
    public static func isFresh(_ mode: OnboardingMode) -> Bool { mode == .new || mode == .guided }

    public static func flowOf(_ mode: OnboardingMode, _ options: FlowOptions = FlowOptions()) -> [String] {
        (FLOWS[mode] ?? FLOWS[.new]!).filter { step in
            (step != "tools" || options.tools)
                && (options.connect ? step != "import" && step != "instructions" : step != "intro" && step != "connect")
        }
    }

    /// Screens that are several screens in effect (2a, 2b …), one box shown at a time. Create has no folder part since
    /// 2026-10-09: a folder is made at ~/<name> unless "Use an existing folder…" under the name picks one.
    public static let SUBS: [String: [String]] = ["import": ["github", "url", "pdf"], "create": ["name", "desc"]]

    /// Where a forward move lands: the next part of the same screen, else the next screen, else 'open'. `detour`: the
    /// context screen sent the person to add to the library (the existing-user flow has no import screen).
    public static func forward(_ mode: OnboardingMode, _ place: OnboardingPlace, _ options: FlowOptions = FlowOptions()) -> OnboardingPlace {
        if let parts = SUBS[place.step], place.sub < parts.count - 1 { return OnboardingPlace(step: place.step, sub: place.sub + 1) }
        if place.step == "context" { return OnboardingPlace(step: "open") }
        if place.detour && place.step == "import" { return OnboardingPlace(step: "context") }
        let full = FLOWS[mode] ?? FLOWS[.new]!
        let flow = flowOf(mode, options)
        if let at = full.firstIndex(of: place.step), let next = full[(at + 1)...].first(where: { flow.contains($0) }) {
            return OnboardingPlace(step: next)
        }
        return flow.contains(place.step) ? OnboardingPlace(step: "open") : OnboardingPlace(step: place.step, sub: place.sub)
    }

    /// The pager under every screen of the flow, or nil off the flow (opening, a detour).
    public static func pagerOf(_ mode: OnboardingMode, _ step: String, _ options: FlowOptions = FlowOptions()) -> PagerPosition? {
        let flow = flowOf(mode, options)
        guard let index = flow.firstIndex(of: step) else { return nil }
        return PagerPosition(count: flow.count, index: index)
    }

    /// Whether a new install's onboarding has the tools screen: nil until the first check, then whether Install all would
    /// install something; with Connect, until Claude Code or Codex is installed and signed in too.
    public static func toolsWanted(_ snapshot: ToolsSnapshot?, connect: Bool = false) -> Bool? {
        guard let snapshot, snapshot.checked else { return nil }
        if !installable(snapshot, launchRows(snapshot)).isEmpty { return true }
        return connect ? !agentReady(snapshot) : false
    }

    /// Claude Code or Codex works: ready, or updating itself in the background (or about to: outdated with automatic
    /// updates on). 2026-10-13: "Codex should update automatically in the background": the update never holds onboarding.
    public static func agentWorks(_ tool: ToolSnapshot?) -> Bool {
        guard let tool else { return false }
        return tool.status == "ready" || (tool.installed && (tool.status == "updating" || (tool.status == "outdated" && tool.autoUpdate)))
    }
    public static func agentReady(_ snapshot: ToolsSnapshot?) -> Bool {
        guard let snapshot else { return false }
        return ["claude", "codex"].contains { agentWorks(snapshot.tools[$0]) }
    }

    public struct ToolsStep: Equatable, Sendable {
        public var ids: [String]; public var install: [String]; public var label: String; public var disabled: Bool; public var stay: Bool
    }
    /// The tools screen's rows and main button (kept for the tools screen's callers; the screen itself left the flow S3).
    public static func toolsStep(_ snapshot: ToolsSnapshot?, connect: Bool = false) -> ToolsStep {
        guard let snapshot else { return ToolsStep(ids: [], install: [], label: "Continue", disabled: true, stay: false) }
        if !connect {
            let ids = launchRows(snapshot)
            let install = installable(snapshot, ids)
            return ToolsStep(ids: ids, install: install, label: install.isEmpty ? "Continue" : "Install all", disabled: false, stay: false)
        }
        let git = snapshot.tools["git"]
        let ids = ((git != nil && git!.status != "ready" && !git!.skip) ? ["git"] : []) + ["claude", "codex"]
        let present = ids.filter { snapshot.tools[$0] != nil }
        if agentReady(snapshot) { return ToolsStep(ids: present, install: [], label: "Continue", disabled: false, stay: false) }
        // An agent installed and waiting for its sign-in: its row's Sign in is the step, not installing the other one.
        let installedAgent = ["claude", "codex"].contains { snapshot.tools[$0]?.installed == true }
        let install = installable(snapshot, installedAgent ? present.filter { $0 == "git" } : present)
        if !install.isEmpty { return ToolsStep(ids: present, install: install, label: "Install all", disabled: false, stay: true) }
        return ToolsStep(ids: present, install: [], label: "Continue", disabled: true, stay: true)
    }

    /// What each tool is for, under its name on the tools screen.
    public static let TOOL_WHY = [
        "git": "Keeps the history of your code. Build needs it.",
        "claude": "Anthropic’s agent. Runs @bart and Build with your Claude account.",
        "codex": "OpenAI’s agent. Runs @bart and Build with your ChatGPT account.",
    ]

    public struct Buttons: Equatable, Sendable {
        public var showSkip: Bool
        public var continueDisabled: Bool
        public var label: String
        public init(showSkip: Bool, continueDisabled: Bool, label: String = "Continue") { self.showSkip = showSkip; self.continueDisabled = continueDisabled; self.label = label }
    }

    /// The import screen's buttons from how many rows its part holds (`n`): Skip while empty; Continue live once it holds
    /// something (no separate Next, 2026-09-28); the GitHub part's once GitHub is connected, nothing ticked (2026-10-02).
    public static func importButtons(_ sub: Int, _ n: Int, signedIn: Bool = false) -> Buttons {
        let connected = (SUBS["import"]!.indices.contains(sub) ? SUBS["import"]![sub] : "") == "github" && signedIn
        return Buttons(showSkip: n == 0, continueDisabled: n == 0 && !connected)
    }

    /// The create screen's: Skip only on an empty description; Continue grey on an empty name, an existing folder not yet
    /// named, an empty description. Neither makes the project (2026-10-10).
    public static func createButtons(_ sub: Int, name: String, desc: String, folder: String = "new", folderPath: String = "") -> Buttons {
        let part = SUBS["create"]!.indices.contains(sub) ? SUBS["create"]![sub] : ""
        func empty(_ value: String) -> Bool { value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return Buttons(showSkip: part == "desc" && empty(desc),
                       continueDisabled: (part == "name" && (empty(name) || (folder == "existing" && empty(folderPath)))) || (part == "desc" && empty(desc)))
    }

    /// What a forward move that lands on 'open' does: a new user's flow makes its project, the guided setup adds a Welcome
    /// workspace to the project it was started in; + Project opens from its context screen.
    public enum End: String, Sendable { case project, welcome }
    public static func endOf(_ mode: OnboardingMode, _ next: OnboardingPlace?) -> End? {
        guard let next, next.step == "open" else { return nil }
        switch mode {
        case .new: return .project
        case .guided: return .welcome
        case .existing: return nil
        }
    }

    /// What a project is made with (ipc start-project), from Create's state.
    public struct ProjectInput: Equatable, Sendable {
        public var name: String
        public var description: String
        public var folder: String
        public var directory: String
        public var context: [String]
        public var connect: String?
        public var onboarding: Bool
        /// The Store's StartProject (the session and `onboarding` go beside it).
        public var start: Onboarding.StartProject {
            Onboarding.StartProject(name: name, description: description, folder: folder, directory: directory, context: context)
        }
    }
    public static func projectInput(name: String, desc: String, folder: String = "new", folderPath: String = "", ids: [String] = [],
                                    connectId: String? = nil, mode: OnboardingMode = .new) -> ProjectInput {
        ProjectInput(name: name.trimmingCharacters(in: .whitespacesAndNewlines), description: desc.trimmingCharacters(in: .whitespacesAndNewlines),
                     folder: folder, directory: folder == "existing" ? folderPath : "", context: ids,
                     connect: connectId?.isEmpty == false ? connectId : nil, onboarding: mode == .new)
    }

    static func hostOf(_ url: String) -> String {
        guard let host = URL(string: url)?.host, !host.isEmpty else { return "" }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// What a library row is, in the words of the context screen: "paper · arxiv.org", "git repo · github.com".
    public static func rowWhy(_ row: LibraryRow) -> String {
        let what = row.hasTag("git") ? "git repo" : row.hasTag("paper") ? "paper" : row.type == "website" ? "website" : row.type
        let url = row.url ?? ""
        let whereFrom = !url.isEmpty && url.range(of: "^file:", options: [.regularExpression, .caseInsensitive]) == nil ? hostOf(url) : ""
        return [what, whereFrom].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The library rows a project can be given: everything but notes (they belong to their project) and pictures.
    public static func contextRows(_ library: [LibraryRow]) -> [LibraryRow] {
        library.filter { !$0.hasTag("note") && $0.type != "image" }
    }

    /// The prompt "Import from an AI provider" copies (Hudson's wording, design chat message 58).
    public static let PROFILE_PROMPT = """
    I want to export a research profile of me that I can give to another AI assistant or collaborator. Using everything you know about me from memory and our past conversations, write a structured profile of me *as a researcher*. Ignore personal, financial, and non-research details unless they directly shape my research.

    Cover the following, and skip any section you have no real evidence for:

    1. Field(s) and position: my disciplines, subfields, career stage, institutional affiliation (or independence), and how I describe my own work.
    2. Core research questions and thesis: the central problem(s) I'm working on, the claims or constructs I've proposed, and what I'm arguing against or distancing myself from.
    3. Current and past projects: for each, the question, study design, data, status (idea / running / analyzing / submitted / published), and target venue.
    4. Methods and epistemology: my methodological commitments (e.g., qualitative vs. quantitative, specific analytic traditions), theoretical frameworks I build on, and standards of evidence I hold myself to.
    5. Intellectual lineage: thinkers, papers, and traditions I draw on, and any I explicitly reject.
    6. Collaborators and ecosystem: advisors, co-authors, labs, and communities, with each person's role.
    7. Open problems: methodological or conceptual issues I'm currently stuck on or actively iterating on.
    8. Trajectory: my research goals, target institutions or venues, and how I'm trying to get there.
    9. Working style: how I want AI to engage with my research (tone, level of pushback, formatting, what to avoid).

    Rules:
    - Be specific. Use the exact terms, names, and framings I've used rather than generic paraphrases.
    - Mark each claim with its epistemic status: [stated] if I said it directly, [inferred] if you're reading it from patterns in our conversations, [uncertain] if you're unsure or it may be outdated.
    - Do not invent details, papers, or collaborators to fill gaps. An empty section is better than a fabricated one.
    - Where something may have changed since I last mentioned it, note roughly when it came up.
    - After the profile, list the 3–5 most important things you *don't* know about my research that would substantially improve the profile, so I can fill them in.

    Output the final profile inside a single code block so I can copy it cleanly.
    """

    // MARK: - Onboarding beta (2026-10-16, docs/onboarding-beta-10-16.md S1–S13)

    /// The pager drawn under a screen (S3: "the pager counts only screens that exist"). Only screens that draw it count:
    /// in a new user's flow Create and Connect are Import your context's own page, which has no pager.
    public static func shownPager(_ mode: OnboardingMode, _ step: String, _ options: FlowOptions?) -> PagerPosition? {
        let opts = options ?? FlowOptions()
        let own = flowOf(mode, opts).filter { !(mode == .new && options?.connect == true && ($0 == "create" || $0 == "connect")) }
        guard let index = own.firstIndex(of: step), own.count >= 2 else { return nil }
        return PagerPosition(count: own.count, index: index)
    }

    /// Claude Code and Codex, as the agent popup names them (S3).
    public static let CLIS = ["claude", "codex"]
    static let PROVIDER_OF_CLI = ["claude": "anthropic", "codex": "openai"]
    public static func providerOfCli(_ id: String) -> String? { PROVIDER_OF_CLI[id] }
    public static func cliOfProvider(_ provider: String?) -> String? { provider == "openai" ? "codex" : provider == "anthropic" ? "claude" : nil }
    /// "Connect to Claude", "Connect to ChatGPT", "Connect to Claude and ChatGPT": the account each CLI signs in with.
    public static let CONNECT_TO = ["claude": "Claude", "codex": "ChatGPT"]
    public static func connectLabel(_ ids: [String]) -> String {
        let names = CLIS.filter { ids.contains($0) }.compactMap { CONNECT_TO[$0] }
        return names.isEmpty ? "" : "Connect to \(names.joined(separator: " and "))"
    }
    /// What a choice in the popup covers: 'claude' | 'codex' | 'both'.
    public static func choiceIds(_ choice: String?) -> [String] {
        choice == "both" ? CLIS : (choice.map { CLIS.contains($0) ? [$0] : [] } ?? [])
    }

    static func providerEntry(_ providers: AgentProviders?, _ id: String) -> AgentProviders.Entry? {
        providers?.providers.first { $0.id == PROVIDER_OF_CLI[id] }
    }
    static let OUTDATED = ["outdated", "incompatible"]

    /// Whether a CLI is installed and signed in with a subscription, by its own word, whatever its version.
    public static func subscribedCli(_ snapshot: ToolsSnapshot?, _ providers: AgentProviders?, _ id: String) -> Bool {
        guard let tool = snapshot?.tools[id], tool.installed, let one = providerEntry(providers, id), tool.status != "missing", tool.status != "failed" else { return false }
        if let subscribed = one.subscribed { return subscribed }
        return one.signedIn && one.subscription != nil
    }

    /// Where one CLI stands for the agent popup.
    public static func cliStage(_ snapshot: ToolsSnapshot?, _ providers: AgentProviders?, _ id: String, refused: Bool = false) -> String {
        guard let tool = snapshot?.tools[id] else { return "connecting" }
        if let busy = tool.busy {
            if busy.action == "sign-in" { return "signing-in" }
            if busy.action != "sign-out" { return "connecting" }
        }
        if ["installing", "checking", "unknown", "updating"].contains(tool.status) { return "connecting" }
        if tool.status == "failed" { return "failed" }
        if !tool.installed || tool.status == "missing" { return (tool.error?.isEmpty == false) ? "failed" : "install" }
        if OUTDATED.contains(tool.status) { return tool.autoUpdate ? "connecting" : "update" }
        if !refused && tool.status == "ready" && subscribedCli(snapshot, providers, id) { return "ready" }
        return "sign-in"
    }

    /// Git is never a row (S3): it ships with the app, and when it is missing anyway it is installed in the background.
    public static func gitMissing(_ snapshot: ToolsSnapshot?) -> Bool {
        guard let git = snapshot?.tools["git"] else { return false }
        return git.status == "missing" && git.busy == nil && !git.skip
    }

    public struct Gate: Equatable, Sendable {
        public var go: Bool
        public var update: [String]
        public var git: Bool
        public var qualifying: [String]
    }
    /// Welcome's Continue (S3): nil while the tool check or the providers have not answered; else go with the qualifying
    /// CLIs that are too old (updated in the background), or not (the popup asks). `git`: Git to install in the background.
    public static func agentGate(_ snapshot: ToolsSnapshot?, _ providers: AgentProviders?) -> Gate? {
        guard let snapshot, snapshot.checked, let providers else { return nil }
        let git = gitMissing(snapshot)
        let qualifying = CLIS.filter { subscribedCli(snapshot, providers, $0) }
        if qualifying.isEmpty { return Gate(go: false, update: [], git: git, qualifying: qualifying) }
        let update = qualifying.filter { id in
            guard let tool = snapshot.tools[id] else { return false }
            return OUTDATED.contains(tool.status) && tool.busy == nil && tool.record.pin == nil && !tool.autoUpdate
        }
        return Gate(go: true, update: update, git: git, qualifying: qualifying)
    }

    public struct Primary: Equatable, Sendable {
        public var label: String
        /// nil | 'sign-in' | 'open' | 'retry'
        public var action: String?
        public var ids: [String]
        public var url: String?
        public var disabled: Bool
    }
    public struct Choice: Equatable, Sendable {
        public var stages: [String: String]
        public var install: [String]
        public var update: [String]
        public var signIn: [String]
        public var failed: [String]
        public var done: Bool
        public var primary: Primary
        public var problem: String
    }
    /// The agent popup for a choice (S3: "Claude Code, Codex, or both").
    public static func agentChoice(_ snapshot: ToolsSnapshot?, _ providers: AgentProviders?, _ choice: String?, refused: String? = nil) -> Choice {
        let ids = choiceIds(choice)
        var stages: [String: String] = [:]
        for id in ids { stages[id] = cliStage(snapshot, providers, id, refused: refused == id) }
        func having(_ stage: String) -> [String] { ids.filter { stages[$0] == stage } }
        let install = having("install"), update = having("update"), signIn = having("sign-in"), failed = having("failed"), signing = having("signing-in")
        let done = !having("ready").isEmpty
        func errorOf(_ list: [String]) -> String {
            for id in list {
                if let error = snapshot?.tools[id]?.error, !error.isEmpty {
                    // The first sentence (split after . ! or ? and a space), at most 160 characters.
                    var first = error
                    if let r = error.range(of: "(?<=[.!?])\\s", options: .regularExpression) { first = String(error[..<r.lowerBound]) }
                    return first.utf16.count > 160 ? String(decoding: Array(first.utf16.prefix(160)), as: UTF16.self) : first
                }
            }
            return ""
        }
        let primary: Primary
        if ids.isEmpty { primary = Primary(label: "Continue", action: nil, ids: [], url: nil, disabled: true) }
        else if done { primary = Primary(label: "Connected", action: nil, ids: [], url: nil, disabled: true) }
        else if !signIn.isEmpty { primary = Primary(label: connectLabel(signIn), action: "sign-in", ids: signIn, url: nil, disabled: false) }
        else if !signing.isEmpty {
            let url = snapshot?.tools[signing[0]]?.busy?.url
            primary = url != nil
                ? Primary(label: "Open sign-in page", action: "open", ids: Array(signing.prefix(1)), url: url, disabled: false)
                : Primary(label: "Finish signing in…", action: nil, ids: [], url: nil, disabled: true)
        } else if !failed.isEmpty && failed.count == ids.count - having("ready").count {
            primary = Primary(label: "Try again", action: "retry", ids: failed, url: nil, disabled: false)
        } else { primary = Primary(label: "Connecting…", action: nil, ids: [], url: nil, disabled: true) }
        return Choice(stages: stages, install: install, update: update, signIn: signIn, failed: failed, done: done, primary: primary,
                      problem: failed.isEmpty ? "" : errorOf(failed))
    }

    /// What comes next for the browser's sign-ins (S9–S12), from api.browsers() (nil while still being looked for).
    public enum KeychainStep: Equatable, Sendable { case wait, go(String), safari, ask }
    public static func keychainStep(_ browsers: JSONValue?) -> KeychainStep {
        guard let browsers, !browsers.isNull else { return .wait }
        let keychain = browsers["keychain"]?.string
        if keychain == "allowed" { return .go("allowed") }
        if keychain == "declined" || keychain == "refused" { return .go("declined") }
        guard let list = browsers["browsers"]?.array, !list.isEmpty else { return .go("declined") }
        if browsers["chosenId"]?.string == "safari" && browsers["safari"]?["diskAccess"]?.bool != true { return .safari }
        return .ask
    }

    /// The chosen browser's profiles ([] for one with a single profile, or none readable).
    public static func profilesOf(_ browsers: JSONValue?) -> [JSONValue] {
        let list = browsers?["browsers"]?.array ?? []
        let chosen = list.first { $0["id"]?.string != nil && $0["id"]?.string == browsers?["chosenId"]?.string }
        return chosen?["profiles"]?.array ?? []
    }

    /// After Allow: "Select your {Browser} profile" when the chosen browser has more than one and none was chosen (S10),
    /// else 'macos': the one prompt macOS shows, at once (S12).
    public static func afterAllow(_ browsers: JSONValue?) -> String {
        let profiles = profilesOf(browsers)
        let chosen = browsers?["chosenProfile"]?.string
        if profiles.count > 1 && !profiles.contains(where: { $0["id"]?.string != nil && $0["id"]?.string == chosen }) { return "profile" }
        return "macos"
    }

    /// The run's `keychain` (S11): from the answer alone.
    public static func runKeychain(_ browsers: JSONValue?) -> Bool { browsers?["keychain"]?.string == "allowed" }
}

public extension ToolsSnapshot {
    /// A tool snapshot from its JSON (the `engelbart:tools` payload), for callers that hold the JSON shape.
    init?(json: JSONValue?) {
        guard let json, let tools = json["tools"]?.object else { return nil }
        var out: [String: ToolSnapshot] = [:]
        for id in TOOL_ORDER {
            guard let t = tools[id], t.object != nil else { continue }
            var record = ToolRecord(blank: id)
            record.installed = t["installed"]?.bool ?? false
            record.version = t["version"]?.string
            record.status = t["status"]?.string ?? "unknown"
            record.signedIn = t["signedIn"]?.bool
            record.account = t["account"]?.string
            record.path = t["path"]?.string
            record.source = t["source"]?.string
            record.error = t["error"]?.string
            record.note = t["note"]?.string
            record.skip = t["skip"]?.bool ?? false
            record.pin = t["pin"]?.string
            var busy: Busy?
            if let b = t["busy"], let action = b["action"]?.string { busy = Busy(action: action, phase: b["phase"]?.string, url: b["url"]?.string) }
            out[id] = ToolSnapshot(record: record, busy: busy, autoUpdate: t["autoUpdate"]?.bool ?? false)
        }
        self.init(checked: json["checked"]?.bool ?? false, platform: json["platform"]?.string ?? "darwin",
                  updates: json["updates"]?.string ?? "auto", tools: out)
    }
}
