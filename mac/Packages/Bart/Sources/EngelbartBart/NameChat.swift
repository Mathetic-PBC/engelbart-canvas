import Foundation
import EngelbartDoc
import EngelbartCore

// name-chat.cjs — a conversation's title (2026-10-12): the `bart# <title>` line above the question that starts an @bart,
// @brainstorm or @discover thread. The editor writes the line empty when the question is asked and the window fills it
// in when this answers, without waiting on it. One short run with no tools and no session, on the provider the question
// runs on and that provider's lowest model (the first the models file lists: Haiku on Claude Code, Luna on Codex) at low
// effort, 15 seconds at most. Whatever goes wrong, the title is the opening message as a title reads (≤60 characters).
// Follow-ups are never named again.

public struct NamedChat: Equatable, Sendable {
    public var title: String, provider: String, model: String, modelName: String, effort: String
    public var ms: Double
    public var named: Bool
    public var json: OJ {
        ["title": .string(title), "provider": .string(provider), "model": .string(model), "modelName": .string(modelName), "effort": .string(effort), "ms": .number(ms), "named": .bool(named)]
    }
}

public enum NameChat {
    public static let prompt = "Name this conversation in 2–6 words, sentence case, no quotes or final period."
    public static let timeout: TimeInterval = 15
    public static let maxTitle = 60
    static let maxWords = 10
    /// What an empty question line is called: there is nothing to name.
    public static let unnamed = "New conversation"
    static let maxQuestion = 4000

    /// The provider a question runs on, as Ask reads it: @bart's line (its flags), @discover's, @brainstorm's default.
    public static func providerOf(_ text: String?, agent: String, _ models: ModelsList) -> String {
        if agent == "brainstorm" { return models.provider }
        if agent == "discover" { return Question.readDiscover(text, models, []).provider }
        return Question.readQuestion(text, models).provider
    }

    /// The model a title is asked of: `provider`'s first model (its lowest), at low effort.
    public static func namingStep(_ models: ModelsList, _ provider: String?) -> Step {
        let at = provider.flatMap { models.providers[$0] != nil ? $0 : nil } ?? models.provider
        let entry = models.providers[at]!
        let (key, info) = entry.models.first!
        return Step(provider: at, key: key, model: info.id, name: info.name, effort: "low")
    }

    static let quotes = "[\"'“”‘’«»]"

    /// Text as a title reads: mentions as their names, agent tokens and flags gone, markdown off, quotes around it and a
    /// final period dropped, one line, the first letter upper case.
    public static func plainTitle(_ text: String?) -> String {
        var s = JSRegex("\\r?\\n").split(text ?? "").map { $0.jsTrim }.first { !$0.isEmpty } ?? ""
        s = JSRegex("@\\[([^\\]\\n]+)\\]\\([^)\\s]*\\)", "g").replace(s) { $0[1] ?? "" }
        s = JSRegex("@\\[([^\\]\\n]+)\\]", "g").replace(s) { $0[1] ?? "" }
        s = JSRegex("(^|\\s)@(?:bart|chat|brainstorm|orient|discover|create)\\b", "gi").replace(s) { $0[1] ?? "" }
        s = JSRegex("(^|\\s)--\\S+", "g").replace(s) { $0[1] ?? "" }
        s = JSRegex("!?\\[([^\\]\\n]*)\\]\\([^)\\s]*\\)", "g").replace(s) { $0[1] ?? "" }
        s = JSRegex("^\\s*(?:#{1,6}\\s+|[-*+]\\s+|\\d+[.)]\\s+|>\\s*)").replace(s, with: "")
        s = JSRegex("(\\*\\*|__|\\*|_|`)(\\S(?:.*?\\S)?)\\1", "g").replace(s) { $0[2] ?? "" }
        s = JSRegex("[*`]", "g").replace(s, with: "")
        s = JSRegex("^(?:title|name)\\s*:\\s*", "i").replace(s, with: "")
        s = s.squashedSpaces
        // A wrapper can hide another: `Title: "## Retry logic."` has its heading mark under the quotes.
        while true {
            var next = JSRegex("^\(quotes)+|\(quotes)+$", "g").replace(s, with: "")
            next = JSRegex("\\.+$").replace(next, with: "")
            next = JSRegex("^(?:#{1,6}\\s+|(?:title|name)\\s*:\\s*)", "i").replace(next, with: "").jsTrim
            if next == s { break }
            s = next
        }
        guard !s.isEmpty else { return "" }
        return s.jsSlice(0, 1).uppercased() + s.jsSlice(1)
    }

    /// At most 60 characters, cut at a word where there is one, with no punctuation left hanging at the end.
    public static func capTitle(_ text: String?) -> String {
        let s = (text ?? "").jsTrim
        if s.jsLength <= maxTitle { return s }
        let cut = s.jsSlice(0, maxTitle + 1)
        let space = (cut as NSString).range(of: " ", options: .backwards).location
        let head = space != NSNotFound && space > maxTitle / 2 ? cut.jsSlice(0, space) : s.jsSlice(0, maxTitle)
        return JSRegex("[\\s,;:–—-]+$").replace(head, with: "")
    }

    public static func cleanTitle(_ raw: String?) -> String { capTitle(plainTitle(raw)) }

    /// The title when no model names it: the opening message as a title reads; "New conversation" only for an empty line.
    public static func fallbackTitle(_ text: String?) -> String { let t = capTitle(plainTitle(text)); return t.isEmpty ? unnamed : t }
}

/// name-chat.cjs createQuickRun: one short run with no tools and no session (shared with @create's line, Making):
/// `step` given `system` and `input`, at most `timeout`. → what the model said, '' when it said nothing usable. Never
/// throws. `codexHome`: Codex is given `system` as its home's instructions, so each kind of run has its own.
public struct QuickRun: Sendable {
    public var environment: [String: String]
    public var runDirectory: String
    public var codexHome: String
    public var codexAuthFile: String?
    public var tools: BartTools?
    public var timeout: TimeInterval
    public var prefix: String
    public var runner: AgentRunner?

    public init(environment: [String: String] = ProcessInfo.processInfo.environment, runDirectory: String, codexHome: String, codexAuthFile: String? = nil,
                tools: BartTools? = nil, timeout: TimeInterval = NameChat.timeout, prefix: String = "name", runner: AgentRunner? = nil) {
        self.environment = environment; self.runDirectory = runDirectory; self.codexHome = codexHome; self.codexAuthFile = codexAuthFile
        self.tools = tools; self.timeout = timeout; self.prefix = prefix; self.runner = runner
    }

    public func callAsFunction(_ step: Step, _ system: String, _ input: String) async -> String {
        let stem = (runDirectory as NSString).appendingPathComponent("\(prefix)-\(IDs.new())")
        defer { for end in [".system.md", ".input.txt", ".out.txt"] { removeFile(stem + end) } }
        do {
            try FileManager.default.createDirectory(atPath: runDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try writePrivate("\(stem).system.md", system)
            try writePrivate("\(stem).input.txt", input)
        } catch { return "" }
        let shell = AgentShell.resolveShell(environment)
        let run: @Sendable () async throws -> String = { [self] in
            if step.provider == "anthropic" {
                let command = "exec \(AgentShell.program("claude", tools)) -p --output-format json --no-session-persistence --setting-sources \"\" --strict-mcp-config --tools \"\" --model \"$ENGELBART_NAME_MODEL\" --effort \(step.effort) --system-prompt-file \"$ENGELBART_NAME_PROMPT\" < \"$ENGELBART_NAME_INPUT\""
                let env = AgentShell.childEnvironment(environment, tools: tools, AgentShell.programEnv("claude", tools).merging(["ENGELBART_NAME_MODEL": step.model, "ENGELBART_NAME_PROMPT": "\(stem).system.md", "ENGELBART_NAME_INPUT": "\(stem).input.txt"]) { $1 })
                let (stdout, _) = await AgentShell.execute(shell: shell, command: command, cwd: runDirectory, env: env, timeout: timeout, runner: runner)
                guard let result = lastResultLine(stdout), result["is_error"]?.bool != true, let text = result["result"]?.string else { return "" }
                return text
            }
            guard prepareCodexHome(codexHome: codexHome, source: codexAuthSource(environment, codexAuthFile), instructions: system) else { return "" }
            let command = "exec \(AgentShell.program("codex", tools)) exec --skip-git-repo-check --ephemeral -s read-only -m \"$ENGELBART_NAME_MODEL\" -c 'model_reasoning_effort=\"\(step.effort)\"' -c 'tools.web_search=false' -c project_doc_max_bytes=0 --color never --json -o \"$ENGELBART_NAME_OUTPUT\" - < \"$ENGELBART_NAME_INPUT\""
            let env = AgentShell.childEnvironment(environment, tools: tools, AgentShell.programEnv("codex", tools).merging(["CODEX_HOME": codexHome, "ENGELBART_NAME_MODEL": step.model, "ENGELBART_NAME_OUTPUT": "\(stem).out.txt", "ENGELBART_NAME_INPUT": "\(stem).input.txt"]) { $1 })
            _ = await AgentShell.execute(shell: shell, command: command, cwd: runDirectory, env: env, timeout: timeout, runner: runner)
            return (try? String(contentsOfFile: "\(stem).out.txt", encoding: .utf8)) ?? ""
        }
        do {
            if let tools { return try await tools.use(Models.toolOf[step.provider] ?? step.provider, run) }
            return try await run()
        } catch { return "" }
    }
}

/// name-chat.cjs createNameChat / createFakeNameChat.
public struct ChatNamer: Sendable {
    public var readModels: @Sendable () -> ModelsList
    public var quickRun: QuickRun?

    /// The real namer; `quickRun` nil is the fake (ENGELBART_BART_FAKE=1): no model, the fallback title.
    public init(readModels: @escaping @Sendable () -> ModelsList, quickRun: QuickRun?) { self.readModels = readModels; self.quickRun = quickRun }

    public func callAsFunction(text: String, provider: String?) async -> NamedChat {
        let started = Date()
        let step = NameChat.namingStep(readModels(), provider)
        func out(_ title: String, _ named: Bool) -> NamedChat {
            NamedChat(title: title, provider: step.provider, model: step.model, modelName: step.name, effort: step.effort, ms: quickRun == nil ? 0 : (Date().timeIntervalSince(started) * 1000).rounded(), named: named)
        }
        guard let quickRun else { return out(NameChat.fallbackTitle(text), false) }
        let question = NameChat.plainTitle(JSRegex("\\s+", "g").replace(text, with: " ")).jsSlice(0, NameChat.maxQuestion)
        if question.isEmpty { return out(NameChat.unnamed, false) }
        // The instruction again after the question, and the title alone: Luna, given it only as instructions, answered the question.
        let raw = await quickRun(step, NameChat.prompt, "The conversation opens with this question:\n\n<question>\n\(question)\n</question>\n\nDo not answer it. \(NameChat.prompt) Reply with the title alone.")
        let title = NameChat.cleanTitle(raw)
        // More words than a title has is an answer, not a name: the fallback.
        if !title.isEmpty && title.components(separatedBy: " ").count <= NameChat.maxWords { return out(title, true) }
        return out(NameChat.fallbackTitle(text), false)
    }
}

// making.cjs — what a Create run is making, in one line (2026-10-15, David): shown above its row a second or two after
// it starts, and the answer's text once it is done. One short run on the provider's lowest model at low effort, given
// the request and the end of the documents, while Create works. Whatever goes wrong, the request as a sentence.
public enum Making {
    public static let prompt = "Someone asked for something to be made. In one line, say what is being made: the kind of thing and what it covers, drawn from their workspace. Start with the kind of thing (\"A diagram of …\", \"An HTML page on …\", \"A chart of …\"). At most 25 words, plain words, no quotes, no markdown, ending with a period. Do not make it."
    public static let timeout: TimeInterval = 15
    public static let maxDocuments = 20_000
    static let maxRequest = 4000
    static let maxWords = 40
    static let maxChars = 260

    /// What the model said as the line shows it; '' when nothing usable is left.
    public static func cleanMaking(_ raw: String?) -> String {
        var s = JSRegex("\\r?\\n").split(raw ?? "").map { $0.jsTrim }.first { !$0.isEmpty } ?? ""
        s = JSRegex("^(?:line|making)\\s*:\\s*", "i").replace(s, with: "")
        s = JSRegex("(\\*\\*|__|\\*|_|`)(\\S(?:.*?\\S)?)\\1", "g").replace(s) { $0[2] ?? "" }
        s = JSRegex("[*`#]", "g").replace(s, with: "")
        s = JSRegex("^[\"'“”‘’«»]+|[\"'“”‘’«»]+$", "g").replace(s, with: "").squashedSpaces
        if s.isEmpty || s.jsLength > maxChars || s.components(separatedBy: " ").count > maxWords || JSRegex("^ESCALATE:", "i").test(s) { return "" }
        s = s.jsSlice(0, 1).uppercased() + s.jsSlice(1)
        return JSRegex("[.!?…]$").test(s) ? s : "\(s)."
    }

    /// "A diagram of …." → "Created a diagram of …."; an acronym's capital stays; '' stays ''.
    public static func createdLine(_ line: String?) -> String {
        let text = (line ?? "").jsTrim
        if text.isEmpty { return "" }
        if JSRegex("^creat(?:ed|ing)\\b", "i").test(text) {
            return JSRegex("…$").replace(JSRegex("^creating\\b", "i").replace(text, with: "Created"), with: ".")
        }
        return "Created \(JSRegex("^[A-Z](?:[a-z]|\\s)").test(text) ? text.jsSlice(0, 1).lowercased() + text.jsSlice(1) : text)"
    }

    /// → (line, named, ms). Never throws.
    public static func making(request: String, documents: String, provider: String, models: ModelsList, quickRun: QuickRun) async -> (line: String, named: Bool, ms: Double) {
        let started = Date()
        let asked = request.squashedSpaces.jsSlice(0, maxRequest)
        let fallback = Create.requestSentence(asked)
        if asked.isEmpty { return (fallback, false, 0) }
        let shown = documents.jsSlice(-maxDocuments)
        let input = "\(shown.isEmpty ? "" : "<documents>\n\(shown)\n</documents>\n\n")<request>\n\(asked)\n</request>\n\n\(prompt) Reply with the line alone."
        let line = cleanMaking(await quickRun(NameChat.namingStep(models, provider), prompt, input))
        let ms = (Date().timeIntervalSince(started) * 1000).rounded()
        return line.isEmpty ? (fallback, false, ms) : (line, true, ms)
    }
}
