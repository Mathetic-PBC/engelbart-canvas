import Foundation
import EngelbartCore

// src/main/agent-map/design.cjs (2026-10-12): the Agent Viewer's Design tab: each agent as it is set up now, read from the
// code and files that set it up, never written down twice. Its system prompt (the data root's
// .context/<agent>-system-prompt.md when it holds any, else the built-in one), its tools on each provider, its model
// steps and efforts as the models file has them now, its time limit, and the blocks of context it is sent; then Build and
// the run step after it; on every entry the agents it hands work to.
//
// What comes from Bart's and Build's code (prompts, tool lists, model ladders, limits, the Build policy) is not this
// package's: the app provides it through `AgentDesignSource` (the Bart and Build packages own those values). The words
// and the shape of each entry are here, as design.cjs writes them.

public struct DesignStep: Sendable, Equatable {
    public var name: String
    public var model: String
    public var effort: String
    public init(name: String, model: String, effort: String) { self.name = name; self.model = model; self.effort = effort }
    var json: JSONValue { ["name": .string(name), "model": .string(model), "effort": .string(effort)] }
}

/// One provider's steps for an agent: a ladder, Discover's per mode, or why none.
public enum DesignSteps: Sendable, Equatable {
    case steps([DesignStep])
    case modes([(String, [DesignStep])])
    case error(String)

    public static func == (a: DesignSteps, b: DesignSteps) -> Bool { a.json == b.json }

    var json: JSONValue {
        switch self {
        case .steps(let s): return ["steps": .array(s.map(\.json))]
        case .modes(let m): return ["modes": .object(Dictionary(uniqueKeysWithValues: m.map { ($0.0, JSONValue.array($0.1.map(\.json))) }))]
        case .error(let e): return ["error": .string(e)]
        }
    }
}

/// What Bart's and Build's code says of each agent now (design.cjs's requires), adapted by the app.
public protocol AgentDesignSource {
    /// The providers in the models file, and the one in force.
    var providers: [String] { get }
    var providerInForce: String? { get }
    /// AGENTS of bart/ask.cjs: ['bart', 'brainstorm', 'discover', 'create'].
    var questionAgents: [String] { get }

    // The router (bart/route.cjs, route-system-prompt.cjs).
    var routePrompt: String { get }
    func routeStep(provider: String) -> DesignStep?
    var routeTimeoutMs: Double { get }
    var sectionChars: Int { get }
    var sureEnough: Double { get }

    // The question agents (bart/ask.cjs, models.cjs, context.cjs, strip.cjs, create.cjs).
    /// PROMPTS[agent][0]: the file name under .context/.
    func promptFileName(_ agent: String) -> String
    /// loadSystemPrompt(dataRoot, agent): the custom file's text when it holds any, else the built-in.
    func systemPrompt(_ agent: String, dataRoot: String?) -> String
    var claudeTools: String { get }
    var brainstormTools: String { get }
    var createTools: String { get }
    var createCodex: [String] { get }
    func createRules(_ draft: String) -> String
    var paperTools: String { get }
    func steps(agent: String, provider: String) -> DesignSteps
    var stepTimeoutMs: Double { get }
    var discoverTimeoutMs: Double { get }
    var deepDiscoverTimeoutMs: Double { get }
    var createTimeoutMs: Double { get }
    var maxCreated: Int { get }
    var maxCreatedBytes: Int { get }
    var scoped: Set<String> { get }
    var zoteroReaders: Set<String> { get }
    var libraryReaders: Set<String> { get }
    var replyBudget: Int { get }
    /// MODE_LIMITS' values, in order.
    var modeLimits: [String] { get }
    var welcomeCards: Int { get }

    // Build (build/prompt.cjs, policy.cjs, runner.cjs, engelbart-tools.cjs, manager.cjs, models.cjs).
    func buildPrompt(dataRoot: String?, quick: Bool) -> String
    /// buildPolicy(PLACEHOLDER): folders, writable, kept, records, gitDir, personal, subagents, computerUse.
    var buildPolicy: (folders: [String], writable: [String], kept: [String], records: [String], gitDir: String, personal: Bool, subagents: Bool, computerUse: Bool) { get }
    var buildTools: String { get }
    var settingSources: String { get }
    var engelbartToolNames: [String] { get }
    var buildDeny: [String] { get }
    /// codexOverrides(policy, …) for the placeholders, or its error.
    var buildCodexOverrides: [String] { get }
    /// buildChoices(buildModels): provider in force and, per provider, its first step, models and efforts; or an error.
    var buildModels: (inForce: String?, providers: [(provider: String, step: DesignStep, models: [(name: String, model: String, use: String)], efforts: [String])], error: String?)? { get }
    var buildTurnMs: (build: Double, quick: Double) { get }
    var buildSlots: (build: Int, quick: Int) { get }

    // The run step (build/run-step.cjs, run-tools.cjs).
    var runStepTemplate: String { get }
    var runTools: [String] { get }
    /// resolveBuildChoice(buildModels, { provider: 'anthropic' }), or nil.
    var runStepFallback: (step: DesignStep, provider: String)? { get }
    var runStepLimits: (runnable: Double, declare: Double, install: Double, windDown: Double) { get }
    var runStepMaxTurns: Int { get }
}

public enum AgentDesign {
    /// What each agent is called on a line and above its Design entry (2026-10-12).
    public static let titles = ["bart": "Chat", "brainstorm": "Brainstorm", "discover": "Discover", "create": "Create"]
    public static let tokens = ["bart": "chat", "brainstorm": "brainstorm", "discover": "discover", "create": "create"]
    /// Where @create writes, named as a placeholder.
    static let draft = "/<data root>/.create/<ask id>"

    /// Who hands work to whom, and how.
    public static func calls(sureEnough: Double) -> [String: [(to: String, how: String)]] {
        let sure = JSONText.number(sureEnough)
        return [
            "router": [("chat", "the router's pick: the line is rewritten @chat and asked"), ("brainstorm", "the router's pick, or an empty @bart"),
                       ("discover", "the router's pick, or --quick, --standard or --deep"), ("create", "the router's pick, sure ≥ \(sure): the line is asked @create at once"),
                       ("build", "--build, or the router's pick with a spec above (else Chat writes the Build prompt)")],
            "bart": [("build", "--build: the line's request becomes a Build; the footer's Build")],
            "brainstorm": [("discover", "its result line, the Welcome handoff, Send to Discover"), ("chat", "its result line, the Welcome handoff")],
            "discover": [("build", "the footer's Build")],
            "create": [],
            "build": [("run step", "on review: a Build turn that ends in review")],
            "run step": [],
        ]
    }

    static func callsJSON(_ list: [(to: String, how: String)]) -> JSONValue { .array(list.map { ["to": .string($0.to), "how": .string($0.how)] }) }

    static func block(_ b: String, _ note: String) -> JSONValue { ["block": .string(b), "note": .string(note)] }

    static func routerDesign(_ src: AgentDesignSource) -> JSONValue {
        let sure = JSONText.number(src.sureEnough)
        var providers: [String: JSONValue] = [:]
        for p in src.providers { providers[p] = src.routeStep(provider: p).map { ["steps": [$0.json]] } ?? ["error": "no model"] }
        return [
            "agent": "router", "title": "Bart (classifier)", "token": "bart",
            "prompt": ["text": .string(src.routePrompt), "custom": false, "file": .null],
            "tools": ["anthropic": ["tools": "", "allowedTools": .null, "papers": false], "openai": ["webSearch": false, "papers": false, "sandbox": "read-only"]],
            "models": ["inForce": src.providerInForce.map { .string($0) } ?? .null, "providers": .object(providers)],
            "timeout": ["route": .number(src.routeTimeoutMs)],
            "rules": .array([("an empty @bart", "@brainstorm"), ("--build", "Build"), ("--quick, --standard or --deep", "@discover"), ("a model or effort flag", "@chat"),
                             ("directly under a @brainstorm or @discover thread", "that agent"),
                             ("otherwise", "the model (bad JSON, a timeout, an error or sure < \(sure) → @chat)"),
                             ("the model says create", "@create when sure ≥ \(sure) (else @chat), started at once"),
                             ("the model says build, a spec above and sure ≥ 0.8", "Build of that fenced block"),
                             ("the model says build otherwise", "@chat, told to write the Build prompt")].map { ["when": .string($0.0), "to": .string($0.1)] }),
            "inputs": ["the line", .string("its section (nearest heading above to the line, the last \(grouped(src.sectionChars)) characters, agent replies left out)"),
                       "the last five threads above (agent, first 80 characters, lines up)", "whether the nearest answer above holds a fenced block", "never the library, context_json or mentioned files"],
            "context": ["blocks": [block("<workspace> <section> <threads> <spec_above> <line>", "one message, no session")], "resumed": ["(none: every line is routed afresh)"], "dirs": "none: no tools"],
        ]
    }

    static func promptOf(_ src: AgentDesignSource, dataRoot: String?, agent: String) -> JSONValue {
        let file = dataRoot.map { join($0, ".context", src.promptFileName(agent)) }
        let custom = file.flatMap { FileOps.read($0) }.map { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? false
        return ["text": .string(src.systemPrompt(agent, dataRoot: dataRoot)), "custom": .bool(custom), "file": file.map { .string($0) } ?? .null]
    }

    static func toolsOf(_ src: AgentDesignSource, _ agent: String) -> JSONValue {
        if agent == "create" {
            return ["anthropic": ["tools": .string(src.createTools), "allowedTools": .string("\(src.createRules(draft)) --permission-mode dontAsk"), "papers": false],
                    "openai": ["overrides": .array((["-C \(draft)"] + src.createCodex + ["tools.web_search=true"]).map { .string($0) })]]
        }
        let allowed = agent == "brainstorm" ? src.brainstormTools : src.claudeTools, mcp = agent == "discover"
        return ["anthropic": ["tools": .string(allowed), "allowedTools": .string(mcp ? "\(allowed),\(src.paperTools)" : allowed), "papers": .bool(mcp)],
                "openai": ["webSearch": .bool(agent != "brainstorm"), "papers": .bool(mcp), "sandbox": "read-only"]]
    }

    static func stepsOf(_ src: AgentDesignSource, _ agent: String) -> JSONValue {
        var out: [String: JSONValue] = [:]
        for p in src.providers { out[p] = src.steps(agent: agent, provider: p).json }
        return ["inForce": src.providerInForce.map { .string($0) } ?? .null, "providers": .object(out)]
    }

    static func contextOf(_ src: AgentDesignSource, _ agent: String) -> JSONValue {
        let scoped = src.scoped.contains(agent)
        var blocks: [JSONValue] = [
            block("<engelbart>", "project, description, code directory, notes folder, where it was asked from\(src.zoteroReaders.contains(agent) ? ", the Zotero mirror" : ""); then the data root's instructions and MEMORY.md"),
            block("<context_json>", scoped ? "the library of this workspace alone (notes made in it, items it mentions)" : "the whole library, each item flagged when the documents mention it"),
            block("<mentioned_files>", "files inside library folders the documents point at (none: left out)"),
            block("documents", scoped ? "the workspace, with every mentioned note under its line; other agents' replies as <reply agent=\"…\">, nearest the line first up to \(grouped(src.replyBudget)) characters, the rest left out with their size (strip.cjs)" : "the workspace, with every mentioned note under its line"),
        ]
        if agent == "bart" { blocks.append(block("<stage> / <highlights>", "the paper, web page or Overleaf editor in front (none: <stage>none</stage>), then the highlights of the papers the documents mention")) }
        blocks.append(block("<conversation>", "the earlier turns of the exchange, when there are any"))
        if agent == "brainstorm" { blocks.append(block("<path> <stage> <card>", "the Welcome walkthrough's exchange only (its own prompt): which of its \(src.welcomeCards) cards comes next; an ordinary Brainstorm is sent none")) }
        if agent == "discover" { blocks.append(block("<mode>", src.modeLimits.joined(separator: " | "))) }
        blocks.append(block("<level>", "the model and effort this step runs on, and whether a higher step exists"))
        blocks.append(block("<question>", agent == "create" ? "what to make: the line after @create" : "the line after the agent's name (an empty line: the opening question)"))
        var resumed: [String] = []
        if agent == "create" { resumed = ["(none: no session is kept, each turn starts from the document)"] } else {
            if agent == "brainstorm" { resumed.append("<path> <stage> <card> (the Welcome walkthrough only)") } else if agent == "discover" { resumed.append("<mode>") }
            if agent == "bart" { resumed.append("<stage> / <highlights> (as they are now)") }
            resumed += ["<level>", "<question>"]
        }
        return ["blocks": .array(blocks), "resumed": .array(resumed.map { .string($0) }),
                "dirs": .string(src.libraryReaders.contains(agent) ? "the code directory and data root, plus the library's folders (read-only)" : "the code directory and data root (read-only)")]
    }

    static func reachOf(_ src: AgentDesignSource) -> String {
        let p = src.buildPolicy
        return [
            "Works in a git worktree of its own, on a branch made for the Build; the person's folder is never touched.",
            "Also works in \(p.folders.joined(separator: " and "))\(p.writable.isEmpty ? "" : " (Codex writes there without asking: \(p.writable.joined(separator: ", ")))").",
            "Kept aside while it works and put back after each turn: \(p.kept.joined(separator: " and ")), and every pdf and picture the library holds.",
            "Refused to the edit tools: \(p.records.joined(separator: ", ")).",
            "Git is Engelbart's alone: the git guard (first on PATH, with hooks on \(p.gitDir)) refuses what writes the repository's history, refs or settings, and every push; Engelbart commits after each turn.",
            "The person's own settings, hooks and MCP servers: \(p.personal ? "yes" : "no"). Subagents: \(p.subagents ? "yes" : "no"). Computer use and browser control: \(p.computerUse ? "yes" : "no").",
        ].joined(separator: " ")
    }

    static func buildEntry(_ src: AgentDesignSource, dataRoot: String?) -> JSONValue {
        let file = dataRoot.map { join($0, ".context", "build-system-prompt.md") }
        let custom = file.flatMap { FileOps.read($0) }.map { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? false
        let text = src.buildPrompt(dataRoot: dataRoot, quick: false), quick = src.buildPrompt(dataRoot: dataRoot, quick: true)
        var models: JSONValue = ["inForce": .null, "providers": .object([:])]
        if let m = src.buildModels {
            if let error = m.error { models = ["inForce": .null, "providers": .object([:]), "error": .string(error)] } else {
                var providers: [String: JSONValue] = [:]
                for p in m.providers {
                    providers[p.provider] = ["steps": [p.step.json], "models": .array(p.models.map { ["name": .string($0.name), "model": .string($0.model), "use": .string($0.use)] }),
                                             "efforts": .array(p.efforts.map { .string($0) })]
                }
                models = ["inForce": m.inForce.map { .string($0) } ?? .null, "providers": .object(providers)]
            }
        }
        return [
            "agent": "build",
            "prompt": ["text": .string(text), "custom": .bool(custom), "file": file.map { .string($0) } ?? .null, "quick": quick != text ? .string(quick) : .null],
            "tools": ["anthropic": ["tools": .string(src.buildTools), "settingSources": .string(src.settingSources), "personal": "the person's own Claude Code settings, hooks and MCP servers",
                                    "engelbart": .array(src.engelbartToolNames.map { .string("mcp__engelbart__\($0)") }), "deny": .array(src.buildDeny.map { .string($0) })],
                      "openai": ["overrides": .array(src.buildCodexOverrides.map { .string($0) }), "engelbart": .array(src.engelbartToolNames.map { .string("engelbart.\($0)") })]],
            "reach": .string(reachOf(src)),
            "models": models,
            "timeout": ["build": .number(src.buildTurnMs.build), "quick": .number(src.buildTurnMs.quick)],
            "slots": ["build": .number(Double(src.buildSlots.build)), "quick": .number(Double(src.buildSlots.quick))],
            "context": [
                "blocks": [block("<engelbart>", "the project, the working copy, the branch and where it started, the person's own folder"),
                           block("<custom_instructions> / <memory>", "the data root's instructions and MEMORY.md, when there are any"),
                           block("<task>", "what to do"),
                           block("<workspace>", "the workspace document with every mentioned note under its line. A line's Build sends <request> instead (what was typed, its notes); a post-it sends <post-it>"),
                           block("<attached>", "library items attached when the Build started"),
                           block("<history>", "the newest archived version of the workspace (not for a line's request)"),
                           block("<context_json>", "the library, each item flagged when the document mentions it")],
                "resumed": ["<reply> (and <attachments>, the images pasted into it)", "a session that will not resume: everything again, <conversation>, then the reply"],
                "dirs": "the worktree, the project folder and the data root's assets (./policy.cjs)",
            ],
            "ends": [["line": "NEEDS YOU: <question>", "means": "a question only the person can answer; the Build waits (needs-you)"],
                     ["line": "ESCALATE: <why>", "means": "a quick task that is not small: it changes nothing and is escalated"],
                     ["line": "(anything else)", "means": "done: the Build goes to review, and its run step starts"]],
            "startedFrom": ["--build on an @chat or @bart line", "Bart's pick, with a spec above", "an answer's footer Build (its last fenced block)", "the Build panel (a workspace's Build button)", "a post-it (a quick task)"],
        ]
    }

    static func runStepEntry(_ src: AgentDesignSource) -> JSONValue {
        let fallback: JSONValue = src.runStepFallback.map { ["name": .string($0.step.name), "model": .string($0.step.model), "effort": .string($0.step.effort), "provider": .string($0.provider)] } ?? .null
        let l = src.runStepLimits
        return [
            "agent": "run step",
            "prompt": ["text": .string(src.runStepTemplate), "custom": false, "file": .null,
                       "note": "written per Build from launch facts (the repository, what the Build changed, the stored commands and how they did); the template, with no facts:"],
            "tools": ["anthropic": ["tools": "", "allowedTools": .string(src.runTools.map { "mcp__canvas__\($0)" }.joined(separator: ",")), "restricted": true], "openai": .null],
            "models": ["rule": "the Build's own model and effort when it ran on Claude Code, else Claude Code's Build step", "fallback": fallback, "providers": .object([:])],
            "timeout": ["runnable": .number(l.runnable), "declare": .number(l.declare), "install": .number(l.install), "windDown": .number(l.windDown)],
            "maxTurns": .number(Double(src.runStepMaxTurns)),
            "context": ["blocks": [block("prompt", "one message, written for the Build (above)")], "resumed": [], "dirs": "none: it reads and writes the worktree through its tools alone"],
            "startedFrom": ["a Build turn that ends in review (never a quick task)"],
        ]
    }

    static func createExtras(_ src: AgentDesignSource) -> [String: JSONValue] {
        ["reach": .string("writes in its draft folder alone (\(draft)/, made empty, its working directory): Claude Code's Write and Edit are allowed there and nowhere else, with no Bash; Codex runs in a workspace-write sandbox rooted there, with no other writable root and no network. A write anywhere else fails."),
         "keeps": .string("after a run that answered, at most \(src.maxCreated) of its files, each at most \(Int((Double(src.maxCreatedBytes) / 1024 / 1024).rounded())) MB and of a format the library reads: .md to assets/md, a pdf or a picture as a copy (assets/pdfs, assets/images), anything else to assets/files/<uuid>/; each row linked to the line's workspace, and the answer mentions each. Then the draft folder is deleted; a run stopped or failed deletes it and keeps nothing.")]
    }

    /// { agents: [...] } for the open data root and the models in force; Bart, the classifier, first.
    public static func agentDesign(_ src: AgentDesignSource, dataRoot: String?) -> JSONValue {
        var agents: [JSONValue] = [routerDesign(src)]
        for agent in src.questionAgents {
            var models = stepsOf(src, agent)
            if agent == "create" { models = models.with("rule", "@chat's models and efforts (no setting of its own)") }
            let timeout: JSONValue = agent == "discover" ? ["quick": .number(src.discoverTimeoutMs), "standard": .number(src.discoverTimeoutMs), "deep": .number(src.deepDiscoverTimeoutMs)]
                : agent == "create" ? ["step": .number(src.createTimeoutMs)] : ["step": .number(src.stepTimeoutMs)]
            var entry: [String: JSONValue] = ["agent": .string(agent), "title": titles[agent].map { .string($0) } ?? .null, "token": tokens[agent].map { .string($0) } ?? .null,
                                              "prompt": promptOf(src, dataRoot: dataRoot, agent: agent), "tools": toolsOf(src, agent), "models": models, "timeout": timeout,
                                              "context": contextOf(src, agent)]
            if agent == "create" { for (k, v) in createExtras(src) { entry[k] = v } }
            agents.append(.object(entry))
        }
        agents.append(buildEntry(src, dataRoot: dataRoot))
        agents.append(runStepEntry(src))
        let callTable = calls(sureEnough: src.sureEnough)
        return ["agents": .array(agents.map { $0.with("calls", callsJSON(callTable[$0["agent"]?.string ?? ""] ?? [])) })]
    }
}
