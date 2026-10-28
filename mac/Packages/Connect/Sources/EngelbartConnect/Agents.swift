import Foundation
import EngelbartCore

// Port of src/main/connect/agents.cjs (Connect your library, 2026-10-07): one turn of its agents, run exactly as @bart runs
// Claude Code and Codex: hidden, on the person's subscription (API keys removed), through the login shell, one process per
// turn, its events read as they arrive for what it is doing.
//   the librarian (interview)  Claude Code --restricted with Read, Grep and Glob over the folders the scan found, its
//                              session resumed turn to turn; Codex in a private home with the read-only sandbox and no web.
//   survey, import, recall     the same file tools, WebSearch and WebFetch, Engelbart's import tools as the MCP server
//                              "engelbart" (this executable `--mcp import <connection>`, over the turn's loopback bridge),
//                              and the connectors' official MCP servers, each with its token for this run only.
//   memory                     Read, Grep and Glob over the session's notes; writes MEMORY.md's draft as its reply.
//   redact                     no tools at all.
//   browse                     an import of a web app in the person's own browser (Claude in Chrome, Codex's Chrome
//                              plugin), run in the Engelbart terminal (AgentTerminal, from the Terminal package).
// Every kind runs on the model its session pinned (Sonnet high or Sol high) with no ladder to climb.

public struct AgentChoice: Sendable, Equatable, Codable {
    public var provider: String
    public var model: String
    public var modelId: String
    public var modelName: String
    public var effort: String
    public init(provider: String, model: String, modelId: String, modelName: String, effort: String) {
        self.provider = provider; self.model = model; self.modelId = modelId; self.modelName = modelName; self.effort = effort
    }
}

/// A connector's server handed to a turn: Engelbart's own sign-in (`token`), or the person's own (`own`, no token).
public struct ConnectorServer: Sendable, Equatable {
    public var app: String
    public var name: String
    public var url: String
    public var token: String?
    public var type: String
    public var own: Bool
    public init(app: String, name: String, url: String, token: String? = nil, type: String = "http", own: Bool = false) {
        self.app = app; self.name = name; self.url = url; self.token = token; self.type = type; self.own = own
    }
}

/// What a turn reports as it goes (agents.cjs onUpdate): its activity in words, a retry, a browser agent's command,
/// screenshot or transcript.
public struct AgentUpdate: Sendable {
    public var activity: String?
    public var retry: (attempt: Int, of: Int, reason: String)?
    public var command: String?
    public var picture: String?
    public var transcript: String?
    public init(activity: String? = nil, retry: (attempt: Int, of: Int, reason: String)? = nil, command: String? = nil, picture: String? = nil, transcript: String? = nil) {
        self.activity = activity; self.retry = retry; self.command = command; self.picture = picture; self.transcript = transcript
    }
}

/// What the fake agents (and the trace) are told besides the turn itself (agents.cjs `meta`).
public struct AgentMeta: @unchecked Sendable {
    public var kind: String
    public var label: String?
    public var sessionId: String?
    public var jobId: String?
    public var jobLabel: String?
    /// The import tools of the job (the fake calls them for real).
    public var callTool: ((String, JSONValue) async throws -> JSONValue)?
    /// The rest the fake reads (the session's choices and found, the job, the digest or evidence), loosely.
    public var info: [String: JSONValue]
    /// The fake librarian's state, kept on the session between turns.
    public var fakeState: FakeInterviewState?
    public init(kind: String, label: String? = nil, sessionId: String? = nil, jobId: String? = nil, jobLabel: String? = nil,
                callTool: ((String, JSONValue) async throws -> JSONValue)? = nil, info: [String: JSONValue] = [:], fakeState: FakeInterviewState? = nil) {
        self.kind = kind; self.label = label; self.sessionId = sessionId; self.jobId = jobId; self.jobLabel = jobLabel; self.callTool = callTool; self.info = info; self.fakeState = fakeState
    }
}

public struct AgentTurnInput: @unchecked Sendable {
    public var choice: AgentChoice
    public var kind: String
    public var system: String
    public var message: String
    public var session: String?
    public var dirs: [String]
    public var signal: AbortSignal?
    public var onUpdate: (AgentUpdate) -> Void
    public var bridge: ToolBridge.Connection?
    public var connectors: [ConnectorServer]
    /// kind browse: where screenshots go, Codex's browser use turned on for the run, the browser's name.
    public var browse: (steps: String, enable: Bool, browser: String)?
    public var toolNames: [String]?
    public var meta: AgentMeta
    public init(choice: AgentChoice, kind: String, system: String, message: String, session: String? = nil, dirs: [String] = [], signal: AbortSignal? = nil,
                onUpdate: @escaping (AgentUpdate) -> Void = { _ in }, bridge: ToolBridge.Connection? = nil, connectors: [ConnectorServer] = [],
                browse: (steps: String, enable: Bool, browser: String)? = nil, toolNames: [String]? = nil, meta: AgentMeta) {
        self.choice = choice; self.kind = kind; self.system = system; self.message = message; self.session = session; self.dirs = dirs; self.signal = signal
        self.onUpdate = onUpdate; self.bridge = bridge; self.connectors = connectors; self.browse = browse; self.toolNames = toolNames; self.meta = meta
    }
}

public struct AgentTurnOutput: Sendable { public var text: String; public var session: String?
    public init(text: String, session: String?) { self.text = text; self.session = session } }

/// What runs a turn: the CLIs (CLIAgents), the fakes (FakeAgents), the trace's wrapper.
public protocol ConnectAgents: AnyObject, Sendable {
    func turn(_ input: AgentTurnInput) async throws -> AgentTurnOutput
}

/// The Engelbart terminal's agent sessions (src/main/terminal/agent-terminal.cjs), which the Terminal package provides: a
/// command run in a pseudo-terminal through the login shell, its output handed over line by line.
public protocol AgentTerminal: AnyObject, Sendable {
    func run(command: String, environment: [String: String], directory: String, signal: AbortSignal?, timeout: TimeInterval,
             onLine: @escaping (String) -> Void) async -> (output: String, exitCode: Int32, timedOut: Bool, stopped: Bool)
}

/// The tool manager (src/main/tools/manager.cjs), which the Tools package provides: where a CLI is, the environment it
/// runs in, and the CLI's lock.
public protocol ConnectToolManager: AnyObject, Sendable {
    func binaryFor(_ name: String) -> String?
    func environment() -> [String: String]
    func ensure(_ cli: String) async throws
    func use<T>(_ cli: String, _ work: () async throws -> T) async throws -> T
    func check(_ clis: [String]) async
}

public enum AgentKinds {
    public static let timeouts: [String: Double] = ["interview": 10 * 60_000, "survey": 15 * 60_000, "import": 45 * 60_000, "recall": 15 * 60_000,
                                                   "memory": 15 * 60_000, "redact": 6 * 60_000, "projects": 4 * 60_000, "discover": 8 * 60_000, "browse": 45 * 60_000]
    public static let bridged: Set<String> = ["survey", "import", "recall", "discover", "browse"]
    static let readTools = "Read,Grep,Glob"
    static let webTools = "WebSearch,WebFetch"
    static let importToolsPrefix = "mcp__engelbart__*"
    public static let chromeRefused = ["javascript_tool", "upload_image", "file_upload", "form_input", "shortcuts_execute", "shortcuts_list", "gif_creator",
                                       "switch_browser", "select_browser", "resize_window"].map { "mcp__claude-in-chrome__\($0)" }
    static let codexKeptServers: Set<String> = ["node_repl"]
    public static let codexBrowseApprovals = "-c 'approval_policy={ granular = { sandbox_approval = false, rules = false, skill_approval = false, request_permissions = false, mcp_elicitations = true } }' -c 'approvals_reviewer=\"auto_review\"'"
    public static let retryWaitsMs: [Double] = [15_000, 45_000]
    static let transientRE = #"at capacity|overloaded|\b(?:429|500|502|503|504|529)\b|rate.?limit|too many requests|temporarily unavailable|service unavailable|internal server error|bad gateway|gateway time-?out|stream (?:disconnected|error|closed)|connection (?:reset|refused|closed|error)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|try again (?:later|shortly|in a)"#
    static let lastingRE = #"usage.?limit|hit your limit|quota|billing|credits?\b|not signed in|log ?in|unauthori[sz]ed|\b40[13]\b|forbidden|invalid (?:api )?key|context (?:window|length)|(?:prompt|input|message) is too long|not found|unsupported|invalid_request"#
    static let maxStepPictures = 80
    static let uuidRE = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    static let serverNameRE = "^[a-z][a-z0-9-]{0,40}$"

    /// Whether a turn's failure is the service's passing refusal (worth the same turn again a little later).
    public static func transientFailure(_ error: Error) -> Bool {
        guard let e = error as? ConnectError, e.kind == "failed" else { return false }
        return JS.test(e.message, transientRE, options: .caseInsensitive) && !JS.test(e.message, lastingRE, options: .caseInsensitive)
    }

    // A connector's tools an agent may call (From Amitav, 2026-10-15): its reading tools, by name, and nothing else.
    public static let connectorReads: [String: ConnectorReads] = [
        "Granola": ConnectorReads(list: ["list_meetings", "list_meeting_folders", "get_account_info"], read: ["get_meetings", "get_meeting_transcript", "get_meeting_attachment", "query_granola_meetings"]),
        "Notion": ConnectorReads(list: ["notion-search", "notion-list-recent-pages", "notion-list-shared-pages", "notion-list-private-pages", "notion-list-favorite-pages", "notion-get-self"],
                                 read: ["notion-fetch", "notion-query-data-sources", "notion-query-meeting-notes"]),
    ]

    /// The tools of a connector an agent of `kind` may call: a survey's list, an import's list and read.
    public static func connectorTools(_ app: String, kind: String) -> [String] {
        guard let reads = connectorReads[app] ?? (ConnectSources.apps[app]?.reach == .connector ? ConnectSources.apps[app]?.reads : nil) else { return [] }
        return kind == "survey" || kind == "discover" ? reads.list : reads.list + reads.read
    }

    static func tokenEnv(_ name: String) -> String { "ENGELBART_CONNECTOR_\(JS.replace(name.uppercased(), "[^A-Z0-9]", "_"))" }

    /// The config.toml of an import agent's private Codex home (agents.cjs writeImportConfig).
    public static func importConfig(server: (command: String, args: [String], env: [String: String]), connectors: [ConnectorServer], kind: String) -> String {
        let toml = CLI.toml as (String) -> String
        var lines = ["# Written by Engelbart (src/main/connect/agents.cjs). Replaced on every run.", "cli_auth_credentials_store = \"file\"", "", "[features]",
                     "computer_use = false", "browser_use = false", "browser_use_external = false", "",
                     "[mcp_servers.engelbart]", "command = \(toml(server.command))", "args = \(CLI.toml(server.args))",
                     "env = { \(server.env.sorted { $0.key < $1.key }.map { "\($0.key) = \(toml($0.value))" }.joined(separator: ", ")) }",
                     "startup_timeout_sec = 30", "tool_timeout_sec = 240", "default_tools_approval_mode = \"approve\""]
        for c in connectors where JS.test(c.name, serverNameRE) && c.name != "engelbart" {
            let reads = connectorTools(c.app, kind: kind)
            if reads.isEmpty { continue }
            // The person's own server: no token here, Codex finds its own sign-in for it by name and address.
            let auth = c.own ? [] : ["bearer_token_env_var = \(toml(tokenEnv(c.name)))"]
            lines += ["", "[mcp_servers.\(c.name)]", "url = \(toml(c.url))"] + auth + ["startup_timeout_sec = 30", "tool_timeout_sec = 120", "enabled_tools = \(CLI.toml(reads))", "default_tools_approval_mode = \"approve\""]
        }
        return lines.joined(separator: "\n") + "\n"
    }

    /// The model an agent's Codex runs (2026-10-15): the pinned one when the person's Codex lists it (models_cache.json),
    /// else the first of the same family (-sol, -luna…), else the first listed.
    public static func codexModel(_ model: String, home: String) -> String {
        guard let cache = Files.readJSON(URL(fileURLWithPath: (home as NSString).appendingPathComponent("models_cache.json"))) else { return model }
        let listed = (cache["models"]?.array ?? []).filter { $0["visibility"]?.string == "list" && JS.test(JS.string($0["slug"]), #"^[\w.-]{1,80}$"#) }.map { JS.string($0["slug"]) }
        if listed.isEmpty || listed.contains(model) { return model }
        if let family = JS.match(model, "-([a-z]+)$")?[1] ?? nil, let same = listed.first(where: { $0.hasSuffix("-\(family)") }) { return same }
        return listed[0]
    }

    /// Claude Code's --mcp-config for a bridged turn: Engelbart's tools (this executable `--mcp import <connection>`) and
    /// the connectors, each token in its header.
    public static func claudeServers(connection: String, connectors: [ConnectorServer], kind: String) -> JSONValue {
        var servers: [String: JSONValue] = ["engelbart": ["command": .string(MCPLaunch.executable), "args": .array(MCPLaunch.arguments("import", [connection]).map { .string($0) }), "env": .object([:])]]
        for c in connectors where JS.test(c.name, serverNameRE) && c.name != "engelbart" && !connectorTools(c.app, kind: kind).isEmpty {
            servers[c.name] = c.own ? ["type": .string(c.type == "sse" ? "sse" : "http"), "url": .string(c.url)]
                : ["type": "http", "url": .string(c.url), "headers": ["Authorization": .string("Bearer \(c.token ?? "")")]]
        }
        return ["mcpServers": .object(servers)]
    }

    /// Claude Code's tools for a kind: what it is given (--tools) and what it may use without asking (--allowedTools).
    public static func claudeToolsFor(_ kind: String, connectors: [ConnectorServer] = []) -> (tools: String, allowed: String) {
        if kind == "redact" || kind == "projects" { return ("", "") }
        if !bridged.contains(kind) { return (readTools, readTools) }
        let tools = "\(readTools),\(webTools)"
        let extra = connectors.filter { JS.test($0.name, serverNameRE) }.flatMap { c in connectorTools(c.app, kind: kind).map { "mcp__\(c.name)__\($0)" } }
        return (tools, ([tools, importToolsPrefix] + extra).joined(separator: ","))
    }

    /// A TOML value for codex's -c (a string, a list, or an inline table of those), as JSON writes strings.
    public static func tomlValue(_ value: JSONValue) -> String {
        switch value {
        case .array(let a): return "[\(a.map(tomlValue).joined(separator: ", "))]"
        case .object(let o): return "{ \(o.sorted { $0.key < $1.key }.map { "\(JS.test($0.key, "^[A-Za-z0-9_-]+$") ? $0.key : JSONValue.string($0.key).text()) = \(tomlValue($0.value))" }.joined(separator: ", ")) }"
        case .number(let n): return JS.number(n)
        case .bool(let b): return b ? "true" : "false"
        default: return JSONValue.string(JS.string(value)).text()
        }
    }

    /// The person's Codex config.toml → the names of their MCP servers a browser agent turns off.
    public static func codexServersOff(_ codexHome: String) -> [String] {
        guard let text = try? String(contentsOfFile: (codexHome as NSString).appendingPathComponent("config.toml"), encoding: .utf8) else { return [] }
        return BrowserAgents.readCodexConfig(text).servers.map(\.name).filter { !codexKeptServers.contains($0) && $0 != "engelbart" && JS.test($0, "^[A-Za-z0-9_-]{1,64}$") }
    }

    /// The person's Codex config.toml → the plugins it turns on that a browser agent turns off (chrome@ kept).
    public static func codexPluginsOff(_ codexHome: String) -> [String] {
        guard let text = try? String(contentsOfFile: (codexHome as NSString).appendingPathComponent("config.toml"), encoding: .utf8) else { return [] }
        return BrowserAgents.readCodexConfig(text).plugins.filter { $0.value && !$0.key.hasPrefix("chrome@") && JS.test($0.key, #"^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$"#) }.map(\.key).sorted()
    }

    // MARK: labels

    static func quote(_ value: String?) -> String { let t = JS.replace(value ?? "", #"\s+"#, " ").trimmingCharacters(in: .whitespaces); return t.count > 40 ? String(t.prefix(39)) + "…" : t }
    static func host(_ url: String?) -> String { CLI.host(url) }
    static func count(_ list: JSONValue?) -> Int { list?.array?.count ?? 0 }
    static func plural(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }
    static func base(_ p: String?, _ fallback: String) -> String { ((p.flatMap { $0.isEmpty ? nil : $0 } ?? fallback) as NSString).lastPathComponent }

    /// What an import tool call is doing, in the person's words: what it was asked, never what came back.
    public static func importToolLabel(_ tool: String, _ input: JSONValue) -> String {
        let s = { (k: String) in input[k]?.string }
        switch tool {
        case "folder_overview": return "Looking through \(base(s("path"), "a folder"))"
        case "list_note_files": return "Listing notes in \(base(s("folder"), "a folder"))"
        case "import_note_files": return "Bringing in \(count(input["files"])) note\(count(input["files"]) == 1 ? "" : "s")"
        case "add_note": return "Writing “\(quote(s("title")))”"
        case "add_to_library": return "Adding \(quote(s("name").flatMap { $0.isEmpty ? nil : $0 } ?? s("input")))"
        case "list_pdfs": return "Listing PDFs in \(base(s("folder"), "a folder"))"
        case "import_pdfs": return "Bringing in \(count(input["files"])) PDF\(count(input["files"]) == 1 ? "" : "s")"
        case "unpack": return "Unpacking \(base(s("file"), "a zip"))"
        case "list_chats", "web_chats": return JS.replace("Listing \(s("app") ?? "") chats", #"\s+"#, " ")
        case "read_chat", "web_chat_read": return JS.replace("Reading a \(s("app") ?? "") chat", #"\s+"#, " ")
        case "import_chats", "import_web_chats": return "Bringing in \(count(input["ids"])) chat\(count(input["ids"]) == 1 ? "" : "s")"
        case "browser_open": return "Opening \(host(s("url")))"
        case "browser_read": return "Reading the page"
        case "browser_click": return "Clicking"
        case "browser_type": return "Typing"
        case "browser_press": return "Pressing \(s("key").flatMap { $0.isEmpty ? nil : $0 } ?? "a key")"
        case "browser_scroll": return "Scrolling"
        case "browser_wait": return "Waiting for the page"
        case "browser_screenshot": return "Looking at the page"
        case "browser_eval": return "Asking the page"
        case "browser_download": return "Downloading from \(host(s("url")))"
        case "import_google_files": return "Bringing in \(count(input["items"])) Google Drive file\(count(input["items"]) == 1 ? "" : "s")"
        case "gmail_accounts": return "Finding your Gmail accounts"
        case "gmail_search": return "Searching your Gmail"
        case "import_gmail_threads": return "Bringing in \(count(input["threads"])) email thread\(count(input["threads"]) == 1 ? "" : "s")"
        case "overleaf_projects": return "Listing your Overleaf projects"
        case "import_overleaf_projects": return "Bringing in \(count(input["ids"])) Overleaf project\(count(input["ids"]) == 1 ? "" : "s")"
        case "apple_notes_folders": return "Reading Apple Notes' folders"
        case "apple_notes_list": return "Listing Apple Notes"
        case "import_apple_notes": return "Bringing in \(count(input["ids"])) Apple Note\(count(input["ids"]) == 1 ? "" : "s")"
        case "browser_history": return "Going through your browser history"
        case "browser_bookmarks": return "Reading your bookmarks"
        case "links_in_notes": return "Finding links in your notes"
        case "zotero_collections": return "Reading your Zotero collections"
        case "zotero_items": return "Reading your Zotero library"
        case "import_zotero_items": return "Bringing in \(count(input["keys"])) paper\(count(input["keys"]) == 1 ? "" : "s")"
        case "github_repos": return "Listing your GitHub repositories"
        case "needs_you", "wait_for_you": return "Waiting for you"
        case "save_memory": return "Keeping what it remembers"
        default: return "Working"
        }
    }

    static func argsOf(_ value: JSONValue?) -> JSONValue {
        if let text = value?.string { return (try? JSONValue.parse(text)) ?? .object([:]) }
        return value ?? .object([:])
    }

    /// A CLI event → its activity: Engelbart's import tools named by importToolLabel, a connector's by its name.
    public static func updateOf(_ provider: String, _ event: JSONValue, _ short: (String?) -> String) -> String? {
        if provider == "anthropic" {
            if event["type"]?.string == "assistant", let content = event["message"]?["content"]?.array, let tool = content.first(where: { $0["type"]?.string == "tool_use" }) {
                let name = tool["name"]?.string ?? ""
                if let own = JS.match(name, #"^mcp__engelbart__(\w+)$"#)?[1] ?? nil { return importToolLabel(own, tool["input"] ?? .object([:])) }
                if let other = JS.match(name, #"^mcp__([\w-]+)__"#)?[1] ?? nil { return "Asking \(JS.replace(other, "[-_]", " "))" }
            }
            return CLI.claudeUpdate(event, short)
        }
        if event["type"]?.string == "item.started", let item = event["item"], item["type"]?.string == "mcp_tool_call" {
            if item["server"]?.string != "engelbart" { return "Asking \(JS.replace(item["server"]?.string ?? "a connector", "[-_]", " "))" }
            return importToolLabel(item["tool"]?.string ?? "", argsOf(item["arguments"]))
        }
        return CLI.codexUpdate(event, short)
    }

    /// A Claude in Chrome tool call, in the person's words.
    public static func chromeToolLabel(_ tool: String, _ input: JSONValue) -> String {
        switch tool {
        case "navigate": return input["url"]?.string.map { "Opening \(host($0))" } ?? "Going back"
        case "tabs_create_mcp": return "Opening its own tab"
        case "tabs_context_mcp": return "Finding its tab"
        case "get_page_text", "read_page", "read_console_messages", "read_network_requests": return "Reading the page"
        case "find": return input["query"]?.string.flatMap { $0.isEmpty ? nil : "Looking for “\(quote($0))”" } ?? "Looking through the page"
        case "list_connected_browsers", "select_browser", "switch_browser": return "Choosing the browser"
        case "resize_window": return "Sizing its window"
        case "browser_batch": return "Working in the browser"
        case "computer":
            let action = input["action"]?.string ?? ""
            if action == "screenshot" || action == "zoom" { return "Looking at the page" }
            if action.contains("click") { return "Clicking" }
            if action == "type" { return "Typing" }
            if action == "key" { return "Pressing \(quote(input["text"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "a key"))" }
            if action.contains("scroll") { return "Scrolling" }
            if action == "wait" { return "Waiting for the page" }
            return "Working in the browser"
        default: return "Working in the browser"
        }
    }

    /// Codex's node_repl call, in the person's words: its own title first.
    public static func replLabel(_ args: JSONValue) -> String {
        if let title = args["title"]?.string, !title.trimmingCharacters(in: .whitespaces).isEmpty { return Cursor.clip(title, 80) }
        let code = args["code"]?.string ?? ""
        let url = JS.match(code, #"https?://[^\s'"`)]+"#)?[0] ?? nil
        if code.contains("tabs.new(") { return url.map { "Opening \(host($0)) in its own tab" } ?? "Opening its own tab" }
        if JS.test(code, #"\.(goto|navigate|open)\("#), let url { return "Opening \(host(url))" }
        if JS.test(code, "screenshot", options: .caseInsensitive) { return "Looking at the page" }
        if JS.test(code, #"\.(click|press_key|perform_secondary_action)\("#) { return "Clicking" }
        if JS.test(code, #"\.(type_text|fill|type|set_value|paste)\("#) { return "Typing" }
        if JS.test(code, "scroll", options: .caseInsensitive) { return "Scrolling" }
        if JS.test(code, #"get_app_state|\.text\(|content\(|innerText|textContent"#) { return "Reading the page" }
        return "Using your browser"
    }

    /// A browser agent's CLI event → its activity and the screenshots it was shown.
    public static func browseUpdateOf(_ provider: String, _ event: JSONValue, _ short: (String?) -> String) -> (activity: String?, pictures: [(type: String, data: String)]) {
        var pictures: [(String, String)] = []
        if provider == "anthropic" {
            if event["type"]?.string == "user", let content = event["message"]?["content"]?.array {
                for block in content where block["type"]?.string == "tool_result" {
                    for part in block["content"]?.array ?? [] where part["type"]?.string == "image" && part["source"]?["type"]?.string == "base64" {
                        if let data = part["source"]?["data"]?.string { pictures.append((part["source"]?["media_type"]?.string ?? "image/png", data)) }
                    }
                }
                return (nil, pictures)
            }
            if event["type"]?.string == "assistant", let tool = event["message"]?["content"]?.array?.first(where: { $0["type"]?.string == "tool_use" }),
               let chrome = JS.match(tool["name"]?.string ?? "", #"^mcp__claude-in-chrome__(\w+)$"#)?[1] ?? nil {
                return (chromeToolLabel(chrome, tool["input"] ?? .object([:])), [])
            }
            return (updateOf(provider, event, short), [])
        }
        if let type = event["type"]?.string, type == "item.started" || type == "item.completed", let item = event["item"], item["type"]?.string == "mcp_tool_call",
           ["node_repl", "cua_repl", "computer-use"].contains(item["server"]?.string ?? "") {
            if type == "item.completed" {
                for part in item["result"]?["content"]?.array ?? [] where part["type"]?.string == "image" {
                    if let data = part["data"]?.string { pictures.append((part["mimeType"]?.string ?? part["mime_type"]?.string ?? "image/png", data)) }
                }
                return (nil, pictures)
            }
            return (replLabel(argsOf(item["arguments"])), [])
        }
        return (updateOf(provider, event, short), [])
    }
}

/// agents.cjs createConnectAgents: turns over the installed CLIs.
public final class CLIAgents: ConnectAgents, @unchecked Sendable {
    let environment: [String: String]
    let runDirectory: String
    let interviewHome: String
    let importHome: String
    let codexAuthFile: String?
    let tools: ConnectToolManager?
    let terminal: AgentTerminal?
    let retryWaits: [Double]
    let sleep: (Double, AbortSignal?) async -> Void

    public init(environment: [String: String] = ProcessInfo.processInfo.environment, runDirectory: String, interviewHome: String, importHome: String? = nil,
                codexAuthFile: String? = nil, tools: ConnectToolManager? = nil, terminal: AgentTerminal? = nil, retryWaits: [Double] = AgentKinds.retryWaitsMs,
                sleep: @escaping (Double, AbortSignal?) async -> Void = { await waitFor($0, $1) }) {
        self.environment = environment; self.runDirectory = runDirectory; self.interviewHome = interviewHome; self.importHome = importHome ?? "\(interviewHome)-import"
        self.codexAuthFile = codexAuthFile; self.tools = tools; self.terminal = terminal; self.retryWaits = retryWaits; self.sleep = sleep
    }

    var codexHomeOfPerson: String { environment["CODEX_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? (NSHomeDirectory() as NSString).appendingPathComponent(".codex") }

    func program(_ name: String) -> String { tools?.binaryFor(name) != nil ? "\"$ENGELBART_\(name.uppercased())_BIN\"" : name }
    func programEnv(_ name: String) -> [String: String] { tools?.binaryFor(name).map { ["ENGELBART_\(name.uppercased())_BIN": $0] } ?? [:] }

    func childEnvironment(_ extra: [String: String]) -> [String: String] {
        var base = CLI.sanitizeEnvironment(CLI.scrubAgentSession(environment))
        for key in CLI.notTheSubscription { base[key] = nil }
        if base["PATH"] == nil || base["PATH"]!.isEmpty { base["PATH"] = ShellEnvironment.path() }
        for (k, v) in tools?.environment() ?? [:] { base[k] = v }
        for (k, v) in extra { base[k] = v }
        return base
    }

    /// The command through the login shell → its stdout and how it ended (127: not found).
    func execute(_ command: String, cwd: String, env: [String: String], signal: AbortSignal?, onEvent: @escaping (JSONValue) -> Void, timeout: Double) async -> (stdout: String, exit: ProcessExit?, failure: String?) {
        let shell = CLI.resolveShell(environment)
        let child = RunningProcess(executable: URL(fileURLWithPath: shell), arguments: CLI.loginShellArgs(shell, command, env), environment: env, directory: URL(fileURLWithPath: cwd))
        child.onStdoutLine = { line in
            let text = line.trimmingCharacters(in: .whitespaces)
            guard text.hasPrefix("{"), let event = try? JSONValue.parse(text) else { return }
            onEvent(event)
        }
        do { try child.start() } catch { return ("", nil, error.localizedDescription) }
        child.closeInput()
        signal?.onAbort { child.terminate(grace: 2) }
        var timedOut = false
        let timer = DispatchWorkItem { timedOut = true; child.terminate(grace: 2) }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout / 1000, execute: timer)
        let exit = await child.wait()
        timer.cancel()
        let failure: String? = exit.succeeded ? nil : (timedOut ? "Command timed out" : "Command failed: \(child.stderrText.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").first ?? "")")
        return (child.stdoutText, exit, failure)
    }

    func write(_ text: String, _ file: String) { try? Files.writeAtomically(text, to: URL(fileURLWithPath: file), mode: 0o600) }
    func remove(_ files: [String]) { for f in files { try? FileManager.default.removeItem(atPath: f) } }

    func connectionFile(_ input: AgentTurnInput, _ path: String) {
        guard let bridge = input.bridge else { return }
        var o: [String: JSONValue] = ["url": .string(bridge.url), "token": .string(bridge.token), "kind": .string(input.kind)]
        if let names = input.toolNames { o["tools"] = .array(names.map { .string($0) }) }
        write(JSONValue.object(o).text(), path)
    }

    func claudeTurn(_ input: AgentTurnInput, stem: String, cwd: String, timeout: Double) async throws -> AgentTurnOutput {
        let promptFile = "\(stem).system.md", inputFile = "\(stem).input.txt", mcpFile = "\(stem).mcp.json", connection = "\(stem).engelbart.json"
        write(input.system, promptFile)
        write(input.message, inputFile)
        let bridged = input.bridge != nil
        if bridged {
            connectionFile(input, connection)
            write(AgentKinds.claudeServers(connection: connection, connectors: input.connectors, kind: input.kind).text(), mcpFile)
        }
        defer { remove([promptFile, inputFile, mcpFile, connection]) }
        let id = input.session ?? IDs.new()
        let grants = input.dirs.indices.map { "--add-dir \"$ENGELBART_CONNECT_DIR\($0)\"" }.joined(separator: " ")
        let servers = bridged ? " --mcp-config \"$ENGELBART_CONNECT_MCP\"" : ""
        let (given, allowed) = AgentKinds.claudeToolsFor(input.kind, connectors: bridged ? input.connectors : [])
        // Not kept in the person's Claude Code history (2026-10-14), but for the librarian's interview.
        let command = "exec \(program("claude")) -p --output-format stream-json --verbose \(input.session != nil ? "--resume" : "--session-id") \"$ENGELBART_CONNECT_SESSION\"\(input.kind == "interview" ? "" : " --no-session-persistence") --restricted --setting-sources \"\" --strict-mcp-config\(servers) --no-chrome --tools \"\(given)\"\(allowed.isEmpty ? "" : " --allowedTools \"\(allowed)\"") --permission-prompts none \(grants) --model \"$ENGELBART_CONNECT_MODEL\" --effort \(input.choice.effort) --system-prompt-file \"$ENGELBART_CONNECT_PROMPT\" < \"$ENGELBART_CONNECT_INPUT\""
        var extra = programEnv("claude").merging(["ENGELBART_CONNECT_SESSION": id, "ENGELBART_CONNECT_MODEL": input.choice.modelId, "ENGELBART_CONNECT_PROMPT": promptFile, "ENGELBART_CONNECT_INPUT": inputFile]) { a, _ in a }
        if bridged { extra["ENGELBART_CONNECT_MCP"] = mcpFile }
        for (n, dir) in input.dirs.enumerated() { extra["ENGELBART_CONNECT_DIR\(n)"] = dir }
        let short = CLI.pathLabeller(input.dirs)
        let out = await execute(command, cwd: cwd, env: childEnvironment(extra), signal: input.signal, onEvent: { event in
            if let activity = AgentKinds.updateOf("anthropic", event, short) { input.onUpdate(AgentUpdate(activity: activity)) }
        }, timeout: timeout)
        if input.signal?.isAborted == true { throw ConnectError.stopped() }
        guard let result = CLI.lastResultLine(out.stdout) else {
            if out.exit?.status == 127 || out.exit == nil { throw ConnectError("unavailable", "Claude Code was not found on the login shell PATH.") }
            throw ConnectError("unavailable", "Claude Code did not return a result\(out.failure.map { " (\($0))" } ?? "").")
        }
        let text = result["result"]?.string ?? ""
        if result["is_error"] == .bool(true) || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let said = JS.truthy(result["result"]) ? JS.string(result["result"]) : JS.truthy(result["subtype"]) ? JS.string(result["subtype"]) : "The model returned no text."
            throw ConnectError("failed", String(said.prefix(300)))
        }
        return AgentTurnOutput(text: text, session: id)
    }

    func codexTurn(_ input: AgentTurnInput, stem: String, cwd: String, timeout: Double) async throws -> AgentTurnOutput {
        let bridged = input.bridge != nil
        // A home of its own for every bridged turn and every discovery turn.
        let own = bridged || input.kind == "projects" ? "\(importHome)-\((stem as NSString).lastPathComponent)" : interviewHome
        let source = codexAuthFile ?? (codexHomeOfPerson as NSString).appendingPathComponent("auth.json")
        guard CLI.prepareCodexHome(codexHome: own, source: source, instructions: input.system) else {
            throw ConnectError("unavailable", "Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used.")
        }
        let inputFile = "\(stem).input.txt", outFile = "\(stem).out.txt", connection = "\(stem).engelbart.json"
        write(input.message, inputFile)
        if bridged {
            connectionFile(input, connection)
            CLI.writeIfChanged(AgentKinds.importConfig(server: (MCPLaunch.executable, MCPLaunch.arguments("import", [connection]), [:]), connectors: input.connectors, kind: input.kind),
                               (own as NSString).appendingPathComponent("config.toml"))
        } else { CLI.writeCodexConfig(home: own) }
        defer {
            remove([inputFile, outFile, connection])
            if own != interviewHome { try? FileManager.default.removeItem(atPath: own) }
        }
        let shared = "--skip-git-repo-check -m \"$ENGELBART_CONNECT_MODEL\" -c 'model_reasoning_effort=\"\(input.choice.effort)\"' -c 'sandbox_mode=\"read-only\"' -c 'tools.web_search=\(bridged ? "true" : "false")' -c project_doc_max_bytes=0 --json -o \"$ENGELBART_CONNECT_OUTPUT\" - < \"$ENGELBART_CONNECT_INPUT\""
        let command = input.session != nil ? "exec \(program("codex")) exec resume \"$ENGELBART_CONNECT_SESSION\" \(shared)" : "exec \(program("codex")) exec --color never \(shared)"
        var extra = programEnv("codex")
        if bridged { for c in input.connectors where JS.test(c.name, AgentKinds.serverNameRE) && !c.own && !(c.token ?? "").isEmpty { extra[AgentKinds.tokenEnv(c.name)] = c.token } }
        extra["CODEX_HOME"] = own
        extra["ENGELBART_CONNECT_SESSION"] = input.session ?? ""
        extra["ENGELBART_CONNECT_MODEL"] = AgentKinds.codexModel(input.choice.modelId, home: codexHomeOfPerson)
        extra["ENGELBART_CONNECT_OUTPUT"] = outFile
        extra["ENGELBART_CONNECT_INPUT"] = inputFile
        let short = CLI.pathLabeller(input.dirs)
        let out = await execute(command, cwd: cwd, env: childEnvironment(extra), signal: input.signal, onEvent: { event in
            if let activity = AgentKinds.updateOf("openai", event, short) { input.onUpdate(AgentUpdate(activity: activity)) }
        }, timeout: timeout)
        if input.signal?.isAborted == true { throw ConnectError.stopped() }
        let text = (try? String(contentsOfFile: outFile, encoding: .utf8)) ?? ""
        var thread = input.session
        for line in out.stdout.components(separatedBy: .newlines) where thread == nil && line.hasPrefix("{") {
            if let event = try? JSONValue.parse(line), event["type"]?.string == "thread.started", let id = event["thread_id"]?.string, JS.test(id, AgentKinds.uuidRE, options: .caseInsensitive) { thread = id }
        }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if out.exit?.status == 127 || out.exit == nil { throw ConnectError("unavailable", "Codex was not found on the login shell PATH.") }
            let reason = out.stdout.components(separatedBy: .newlines).reversed().first { JS.test($0, #""type":"(error|turn\.failed)"|^ERROR"#) } ?? out.failure ?? "Codex returned no message."
            throw ConnectError("failed", String(reason.prefix(300)))
        }
        return AgentTurnOutput(text: text, session: thread)
    }

    /// A browser agent's CLI in the Engelbart terminal: its JSON events read line by line, each step said in words, each
    /// screenshot kept in `steps` (≤80), the transcript handed over at the end for the Agent trace.
    func inTerminal(provider: String, command: String, env: [String: String], cwd: String, input: AgentTurnInput, timeout: Double) async throws -> (stdout: String, exitCode: Int32, timedOut: Bool) {
        guard let terminal else { throw ConnectError("unavailable", "The Engelbart terminal is not available here.") }
        let short = CLI.pathLabeller(input.dirs)
        var pictures = 0
        let lock = NSLock()
        var lines: [String] = []
        let steps = input.browse?.steps
        let out = await terminal.run(command: command, environment: env, directory: cwd, signal: input.signal, timeout: timeout / 1000) { text in
            let trimmed = text.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("{") else { return }
            lock.lock(); lines.append(trimmed); lock.unlock()
            guard let event = try? JSONValue.parse(trimmed) else { return }
            let update = AgentKinds.browseUpdateOf(provider, event, short)
            if let steps {
                for picture in update.pictures {
                    lock.lock()
                    if pictures >= AgentKinds.maxStepPictures { lock.unlock(); break }
                    pictures += 1
                    let n = pictures
                    lock.unlock()
                    let ext = JS.test(picture.type, "jpe?g") ? "jpg" : picture.type.contains("webp") ? "webp" : "png"
                    let file = (steps as NSString).appendingPathComponent(String(format: "%03d.%@", n, ext))
                    try? FileManager.default.createDirectory(atPath: steps, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                    if let data = Data(base64Encoded: picture.data), FileManager.default.createFile(atPath: file, contents: data, attributes: [.posixPermissions: 0o600]) {
                        input.onUpdate(AgentUpdate(picture: file))
                    }
                }
            }
            if let activity = update.activity { input.onUpdate(AgentUpdate(activity: activity)) }
        }
        input.onUpdate(AgentUpdate(transcript: out.output))
        if out.stopped || input.signal?.isAborted == true { throw ConnectError.stopped() }
        lock.lock(); defer { lock.unlock() }
        return (lines.joined(separator: "\n"), out.exitCode, out.timedOut)
    }

    func claudeBrowse(_ input: AgentTurnInput, stem: String, cwd: String, timeout: Double) async throws -> AgentTurnOutput {
        let promptFile = "\(stem).system.md", inputFile = "\(stem).input.txt", mcpFile = "\(stem).mcp.json", connection = "\(stem).engelbart.json"
        write(input.system, promptFile)
        write(input.message, inputFile)
        let bridged = input.bridge != nil
        if bridged {
            connectionFile(input, connection)
            write(AgentKinds.claudeServers(connection: connection, connectors: input.connectors, kind: input.kind).text(), mcpFile)
        }
        defer { remove([promptFile, inputFile, mcpFile, connection]) }
        let id = IDs.new()
        let grants = input.dirs.indices.map { "--add-dir \"$ENGELBART_CONNECT_DIR\($0)\"" }.joined(separator: " ")
        let servers = bridged ? " --mcp-config \"$ENGELBART_CONNECT_MCP\"" : ""
        let (given, allowed) = AgentKinds.claudeToolsFor(input.kind, connectors: bridged ? input.connectors : [])
        let refused = AgentKinds.chromeRefused.joined(separator: ",")
        // The browser calls are left to auto mode's classifier; every prompt it would raise is refused.
        let command = "exec \(program("claude")) -p --output-format stream-json --verbose --session-id \"$ENGELBART_CONNECT_SESSION\" --no-session-persistence --setting-sources \"\" --strict-mcp-config\(servers) --chrome --tools \"\(given)\" --allowedTools \"\(allowed)\" --disallowedTools \"\(refused)\" --permission-mode auto --permission-prompts none \(grants) --model \"$ENGELBART_CONNECT_MODEL\" --effort \(input.choice.effort) --system-prompt-file \"$ENGELBART_CONNECT_PROMPT\" < \"$ENGELBART_CONNECT_INPUT\""
        var extra = programEnv("claude").merging(["ENGELBART_CONNECT_SESSION": id, "ENGELBART_CONNECT_MODEL": input.choice.modelId, "ENGELBART_CONNECT_PROMPT": promptFile, "ENGELBART_CONNECT_INPUT": inputFile]) { a, _ in a }
        if bridged { extra["ENGELBART_CONNECT_MCP"] = mcpFile }
        for (n, dir) in input.dirs.enumerated() { extra["ENGELBART_CONNECT_DIR\(n)"] = dir }
        input.onUpdate(AgentUpdate(command: "claude -p --chrome --setting-sources \"\" --strict-mcp-config --tools \"\(given)\" --disallowedTools \"\(refused)\" --permission-mode auto --permission-prompts none --model \(input.choice.modelId) --effort \(input.choice.effort)"))
        let out = try await inTerminal(provider: "anthropic", command: command, env: childEnvironment(extra), cwd: cwd, input: input, timeout: timeout)
        guard let result = CLI.lastResultLine(out.stdout) else {
            throw ConnectError("unavailable", out.exitCode == 127 ? "Claude Code was not found on the login shell PATH." : "Claude Code did not return a result\(out.timedOut ? " (it ran out of time)" : "").")
        }
        let text = result["result"]?.string ?? ""
        if result["is_error"] == .bool(true) || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw ConnectError("failed", String((JS.truthy(result["result"]) ? JS.string(result["result"]) : JS.truthy(result["subtype"]) ? JS.string(result["subtype"]) : "The model returned no text.").prefix(300)))
        }
        return AgentTurnOutput(text: text, session: id)
    }

    func codexBrowse(_ input: AgentTurnInput, stem: String, cwd: String, timeout: Double) async throws -> AgentTurnOutput {
        let home = codexHomeOfPerson
        let inputFile = "\(stem).input.txt", outFile = "\(stem).out.txt", connection = "\(stem).engelbart.json"
        write(input.message, inputFile)
        let bridged = input.bridge != nil
        if bridged { connectionFile(input, connection) }
        defer { remove([inputFile, outFile, connection]) }
        let off = (AgentKinds.codexServersOff(home).map { "-c 'mcp_servers.\($0).enabled=false'" } + AgentKinds.codexPluginsOff(home).map { "-c 'plugins.\"\($0)\".enabled=false'" }).joined(separator: " ")
        let enable = "\(input.browse?.enable == true ? " --enable browser_use" : "") --disable computer_use"
        // --ephemeral: the run is not kept in the person's Codex history.
        let command = "exec \(program("codex")) exec --ephemeral --skip-git-repo-check --color never -m \"$ENGELBART_CONNECT_MODEL\" -c 'model_reasoning_effort=\"\(input.choice.effort)\"' -c 'sandbox_mode=\"read-only\"' \(AgentKinds.codexBrowseApprovals) -c project_doc_max_bytes=0 -c \"developer_instructions=$ENGELBART_CONNECT_INSTRUCTIONS\" \(off)\(bridged ? " -c \"mcp_servers.engelbart=$ENGELBART_CONNECT_SERVER\"" : "") --disable apps\(enable) --json -o \"$ENGELBART_CONNECT_OUTPUT\" - < \"$ENGELBART_CONNECT_INPUT\""
        var extra = programEnv("codex")
        extra["CODEX_HOME"] = home
        extra["ENGELBART_CONNECT_MODEL"] = AgentKinds.codexModel(input.choice.modelId, home: home)
        extra["ENGELBART_CONNECT_OUTPUT"] = outFile
        extra["ENGELBART_CONNECT_INPUT"] = inputFile
        extra["ENGELBART_CONNECT_INSTRUCTIONS"] = AgentKinds.tomlValue(.string(input.system))
        if bridged {
            extra["ENGELBART_CONNECT_SERVER"] = AgentKinds.tomlValue(["command": .string(MCPLaunch.executable), "args": .array(MCPLaunch.arguments("import", [connection]).map { .string($0) }),
                                                                    "env": .object([:]), "startup_timeout_sec": 30, "tool_timeout_sec": 240, "default_tools_approval_mode": "approve"])
        }
        input.onUpdate(AgentUpdate(command: "codex exec -m \(input.choice.modelId) -c model_reasoning_effort=\"\(input.choice.effort)\" -c sandbox_mode=\"read-only\" \(AgentKinds.codexBrowseApprovals.replacingOccurrences(of: "'", with: "")) -c developer_instructions=<the system prompt> \(off.replacingOccurrences(of: "'", with: ""))\(bridged ? " -c mcp_servers.engelbart=<Engelbart's import tools>" : "") --disable apps\(enable)"))
        let out = try await inTerminal(provider: "openai", command: command, env: childEnvironment(extra), cwd: cwd, input: input, timeout: timeout)
        let text = (try? String(contentsOfFile: outFile, encoding: .utf8)) ?? ""
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if out.exitCode == 127 { throw ConnectError("unavailable", "Codex was not found on the login shell PATH.") }
            let reason = out.stdout.components(separatedBy: .newlines).reversed().first { JS.test($0, #""type":"(error|turn\.failed)""#) } ?? (out.timedOut ? "It ran out of time." : "Codex returned no message.")
            throw ConnectError("failed", String(reason.prefix(300)))
        }
        return AgentTurnOutput(text: text, session: nil)
    }

    public func turn(_ input: AgentTurnInput) async throws -> AgentTurnOutput {
        try? FileManager.default.createDirectory(atPath: runDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let stem = (runDirectory as NSString).appendingPathComponent("\(input.kind)-\(IDs.new())")
        let timeout = AgentKinds.timeouts[input.kind] ?? AgentKinds.timeouts["import"]!
        let cli = input.choice.provider == "openai" ? "codex" : "claude"
        var fixed = input
        if !AgentKinds.bridged.contains(input.kind) { fixed.bridge = nil }
        let once: () async throws -> AgentTurnOutput = { [self] in
            if fixed.kind == "browse" { return cli == "codex" ? try await codexBrowse(fixed, stem: stem, cwd: runDirectory, timeout: timeout) : try await claudeBrowse(fixed, stem: stem, cwd: runDirectory, timeout: timeout) }
            return cli == "codex" ? try await codexTurn(fixed, stem: stem, cwd: runDirectory, timeout: timeout) : try await claudeTurn(fixed, stem: stem, cwd: runDirectory, timeout: timeout)
        }
        let attempt: () async throws -> AgentTurnOutput = { [self] in
            guard let tools else { return try await once() }
            try await tools.ensure(cli)
            do { return try await tools.use(cli, once) } catch let e as ConnectError where e.kind == "unavailable" { Task { await tools.check([cli]) }; throw e }
        }
        // The service's passing refusals tried again, the person told what is happening meanwhile.
        var tries = 0
        while true {
            do { return try await attempt() } catch {
                if tries >= retryWaits.count || !AgentKinds.transientFailure(error) || input.signal?.isAborted == true { throw error }
                let seconds = Int((retryWaits[tries] / 1000).rounded())
                input.onUpdate(AgentUpdate(activity: "The model is busy: trying again\(seconds > 0 ? " in \(seconds) s" : "")",
                                           retry: (tries + 2, retryWaits.count + 1, Cursor.clip((error as? ConnectError)?.message ?? error.localizedDescription, 200))))
                await sleep(retryWaits[tries], input.signal)
                if input.signal?.isAborted == true { throw ConnectError.stopped() }
                tries += 1
            }
        }
    }
}
