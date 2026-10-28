import Foundation
import EngelbartCore

// Port of src/shared/import-flow.cjs (Import your context, 2026-10-13, the "Onboarding" workspace and its mockup): what
// the work-first import flow decides, without any I/O. The flow:
//   Import context → How would you like to import context? (agents choose | choose sources myself)
//   → What kind of work do you do? → What are you working on? → What project do you want to work on first?
//   → agents: Confirm your tools → Import to Engelbart
//   → myself: the source picker → Import to Engelbart
// A project-discovery agent starts the moment Import context is pressed and returns 1-5 recent projects; a tool-discovery
// agent says which of the catalog's tools the person uses. Then the direct sessions (Session.swift) import each tool.

public enum ImportFlow {
    /// Code's second row: repositories and folders on this Mac, chosen with the folder picker.
    public static let localFolders = "Folders on this Mac"
    /// Websites' one row: the browser's history.
    public static let sites = "__sites"
    /// Apps left out of Import your context for now (From Amitav, 2026-10-15: "Get rid of Gmail and Calendar imports for now").
    public static let pausedApps = ["Gmail"]

    /// The picker's groups: Connect's sources minus a paused app (a category it empties goes with it), Code holding GitHub
    /// and the folders on this Mac, then Other.
    public static let groups: [SourceGroup] = ConnectSources.sources.compactMap { source in
        let emptied = !source.apps.isEmpty && source.apps.allSatisfy { pausedApps.contains($0) }
        if emptied { return nil }
        let apps = source.id == "code" ? ["GitHub", localFolders] : source.apps.filter { !pausedApps.contains($0) }
        return SourceGroup(id: source.id, label: source.label, apps: apps)
    }
    public static var groupIds: [String] { groups.map(\.id) }

    public static func groupOfApp(_ app: String) -> String? {
        if app == sites { return "sites" }
        return groups.first { $0.apps.contains(app) }?.id
    }

    /// A category the tool agent named, as one of the groups (its id or its label, any case), else Other.
    public static func categoryOf(_ value: String?) -> String {
        let said = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return groups.first { $0.id == said || $0.label.lowercased() == said }?.id ?? "other"
    }

    /// Tools the agents may not bring back while calendars and mail are paused (From Amitav, 2026-10-15).
    public static func isPausedTool(_ name: String) -> Bool {
        name.range(of: #"\b(calendars?|calendly|cal\.com|fantastical|outlook|g?mail)\b"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// How an app is reached: 'local', 'web', 'connector', 'signin', 'automation'.
    public static func reachOf(_ app: String) -> Reach {
        if app == sites || app == localFolders { return .local }
        return ConnectSources.apps[app]?.reach ?? .local
    }
    public static func isLocal(_ app: String) -> Bool { [.local, .automation].contains(reachOf(app)) }
    public static func isWebApp(_ app: String) -> Bool { reachOf(app) == .web }

    public struct CatalogTool: Sendable, Equatable { public var id: String; public var name: String; public var group: String; public var local: Bool }
    /// Every tool the tools page can list: each picker app, and the browser's history.
    public static let catalog: [CatalogTool] = groups.flatMap { group in
        group.apps.map { CatalogTool(id: $0, name: $0 == sites ? "Saved URLs" : ConnectSources.shownName($0), group: group.id, local: isLocal($0)) }
    } + [CatalogTool(id: sites, name: "Saved URLs", group: "sites", local: true)]
    public static var catalogIds: [String] { catalog.map(\.id) }
    public static func catalogTool(_ id: String) -> CatalogTool? { catalog.first { $0.id == id } }

    public struct Role: Sendable { public var name: String; public var paths: String }
    /// "What kind of work do you do?", each with its icon's SVG paths (24 × 24, stroked).
    public static let roles: [Role] = [
        Role(name: "Researcher", paths: #"<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M8 15h8"/>"#),
        Role(name: "Writer", paths: #"<path d="m15 3 6 6L8 22l-6 1 1-6zm-2 2 6 6M5 17l3 3"/>"#),
        Role(name: "Founder", paths: #"<rect x="4" y="4" width="16" height="12" rx="2"/><path d="m4 16-2 4h20l-2-4M10 20h4"/>"#),
        Role(name: "Professor", paths: #"<path d="m2 8 10-5 10 5-10 5-10-5zm4 3v6c4 3 8 3 12 0v-6m4-3v9"/>"#),
        Role(name: "Student", paths: #"<path d="M3 5h6c2 0 3 1 3 3v13c0-2-1-3-3-3H3zm18 0h-6c-2 0-3 1-3 3v13c0-2 1-3 3-3h6z"/>"#),
        Role(name: "Engineer", paths: #"<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>"#),
        Role(name: "Designer", paths: #"<rect x="3" y="3" width="7" height="7" rx="1"/><circle cx="17" cy="6.5" r="3.5"/><path d="m6.5 14 4 7h-8z"/><rect x="13.5" y="14" width="7" height="7" rx="3.5"/>"#),
        Role(name: "Other", paths: #"<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>"#),
    ]
    public static var roleNames: [String] { roles.map(\.name) }

    // MARK: providers

    public static let providerIds = ["anthropic", "openai"]
    public static let providerNames = ["anthropic": "Claude Code", "openai": "Codex"]

    public struct ProviderFacts: Sendable, Equatable {
        public var id: String
        public var installed: Bool
        public var signedIn: Bool
        /// A plan's name, or nil.
        public var subscription: String?
        /// When it was first used (ms), or nil.
        public var since: Double?
        public init(id: String, installed: Bool, signedIn: Bool, subscription: String? = nil, since: Double? = nil) {
            self.id = id; self.installed = installed; self.signedIn = signedIn; self.subscription = subscription; self.since = since
        }
    }

    public struct ProviderChoice: Sendable, Equatable {
        public var pick: String?
        public var ask: Bool
        public var choices: [String]
        public var setup: Bool
        public var suggested: String?
    }

    /// Which provider runs onboarding's agents (2026-10-13): both subscribed → ask every time (the one picked before
    /// suggested); one subscribed → that one; else the one with most seniority; none ready → the tools setup first.
    public static func chooseProvider(_ providers: [ProviderFacts], remembered: String? = nil) -> ProviderChoice {
        let list = providers.filter { providerIds.contains($0.id) }
        let ready = list.filter { $0.installed && $0.signedIn }
        if ready.isEmpty { return ProviderChoice(pick: nil, ask: false, choices: [], setup: true, suggested: nil) }
        let subscribed = ready.filter { ($0.subscription ?? "").isEmpty == false }
        if subscribed.count >= 2 {
            let suggested = remembered.flatMap { r in subscribed.contains { $0.id == r } ? r : nil }
            return ProviderChoice(pick: nil, ask: true, choices: subscribed.map(\.id), setup: false, suggested: suggested)
        }
        if subscribed.count == 1 { return ProviderChoice(pick: subscribed[0].id, ask: false, choices: [subscribed[0].id], setup: false, suggested: nil) }
        let senior = ready.sorted { a, b in
            let sa = a.since.flatMap { $0.isFinite ? $0 : nil } ?? .infinity
            let sb = b.since.flatMap { $0.isFinite ? $0 : nil } ?? .infinity
            if sa != sb { return sa < sb }
            return (providerIds.firstIndex(of: a.id) ?? 0) < (providerIds.firstIndex(of: b.id) ?? 0)
        }[0]
        return ProviderChoice(pick: senior.id, ask: false, choices: [senior.id], setup: false, suggested: nil)
    }

    // MARK: browsers

    public struct Browser: Sendable, Equatable { public var id: String; public var name: String; public var bundle: String; public var keychain: Bool }
    /// The browsers whose sign-ins Engelbart can use (2026-10-13). Safari's are read from its cookie file (Full Disk Access).
    public static let browsers: [Browser] = [
        Browser(id: "safari", name: "Safari", bundle: "com.apple.Safari", keychain: false),
        Browser(id: "chrome", name: "Chrome", bundle: "com.google.Chrome", keychain: true),
        Browser(id: "brave", name: "Brave", bundle: "com.brave.Browser", keychain: true),
        Browser(id: "firefox", name: "Firefox", bundle: "org.mozilla.firefox", keychain: false),
        Browser(id: "arc", name: "Arc", bundle: "company.thebrowser.Browser", keychain: true),
        Browser(id: "edge", name: "Edge", bundle: "com.microsoft.edgemac", keychain: true),
        Browser(id: "opera", name: "Opera", bundle: "com.operasoftware.Opera", keychain: true),
        Browser(id: "chromium", name: "Chromium", bundle: "org.chromium.Chromium", keychain: true),
        Browser(id: "comet", name: "Comet", bundle: "ai.perplexity.comet", keychain: true),
    ]
    public static func browserById(_ id: String?) -> Browser? { browsers.first { $0.id == id } }

    private static let defaultNames: [(String, String)] = [("safari", "safari"), ("chromium", "chromium"), ("chrome", "chrome"), ("brave", "brave"),
                                                           ("firefox", "firefox"), (#"^arc\b"#, "arc"), ("edge", "edge"), ("opera", "opera"), ("comet", "comet")]
    /// macOS's name for the default browser → an id here.
    public static func browserIdOfName(_ name: String?) -> String? {
        let text = name ?? ""
        return defaultNames.first { text.range(of: $0.0, options: [.regularExpression, .caseInsensitive]) != nil }?.1
    }

    /// The installed browsers (ids), the default first, then the rest in `browsers`' order.
    public static func orderBrowsers(_ installed: [String], defaultId: String?) -> [String] {
        let have = Set(installed)
        let out = browsers.filter { have.contains($0.id) }.map(\.id)
        if let d = defaultId, have.contains(d) { return [d] + out.filter { $0 != d } }
        return out
    }

    // MARK: discovery replies

    /// `String(value == null ? '' : value)`, whitespace runs to one space, trimmed, cut to `max` with an ellipsis.
    public static func clip(_ value: Any?, _ max: Int) -> String {
        let text = JS.string(value).replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return JS.cut(text, max)
    }

    /// The JSON object in a model's reply (fences and words around it tolerated), or nil.
    public static func jsonOf(_ text: String?) -> JSONValue? {
        var raw = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        raw = raw.replacingOccurrences(of: #"^```(?:json)?\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
        raw = raw.replacingOccurrences(of: #"\s*```$"#, with: "", options: .regularExpression)
        guard let start = raw.firstIndex(of: "{"), let end = raw.lastIndex(of: "}"), start < end else { return nil }
        guard let value = try? JSONValue.parse(String(raw[start...end])) else { return nil }
        switch value { case .object, .array: return value; default: return nil }
    }

    public static func slug(_ text: String?) -> String {
        let s = (text ?? "").lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .replacingOccurrences(of: "^-+|-+$", with: "", options: .regularExpression)
        let cut = String(s.prefix(48))
        return cut.isEmpty ? "project" : cut
    }

    public struct Project: Sendable, Equatable, Codable {
        public var id: String
        public var title: String
        public var description: String
        public var recent: String
        public var folder: String
        public var evidence: String
        public init(id: String, title: String, description: String = "", recent: String = "", folder: String = "", evidence: String = "") {
            self.id = id; self.title = title; self.description = description; self.recent = recent; self.folder = folder; self.evidence = evidence
        }
    }

    /// The project-discovery agent's reply made safe: 1-5 projects with unique ids and titles of at most 80 characters;
    /// nil when there is not one usable project.
    public static func readProjects(_ text: String?) -> [Project]? {
        guard let list = jsonOf(text)?["projects"]?.array else { return nil }
        var out: [Project] = []
        var seen = Set<String>()
        for entry in list {
            guard case .object = entry else { continue }
            let title = clip(entry["title"], 80)
            if title.isEmpty { continue }
            let idSource = JS.truthy(entry["id"]) ? JS.string(entry["id"]) : title
            var id = slug(idSource)
            while seen.contains(id) { id += "-2" }
            seen.insert(id)
            var folder = ""
            if let f = entry["folder"]?.string {
                let t = f.trimmingCharacters(in: .whitespacesAndNewlines)
                if t.hasPrefix("/") { folder = String(t.prefix(1024)) }
            }
            out.append(Project(id: id, title: title, description: clip(entry["description"], 240), recent: clip(entry["recent"], 24),
                               folder: folder, evidence: clip(entry["evidence"], 240)))
            if out.count == 5 { break }
        }
        return out.isEmpty ? nil : out
    }

    public struct ToolFact: Sendable, Equatable, Codable {
        public var used: Bool
        public var evidence: String
        public var method: String
        public init(used: Bool, evidence: String = "", method: String = "none") { self.used = used; self.evidence = evidence; self.method = method }
    }
    public struct ToolAnswer: Sendable, Equatable, Codable { public var id: String; public var used: Bool; public var evidence: String; public var method: String }
    public struct ExtraTool: Sendable, Equatable, Codable {
        public var name: String; public var website: String; public var used: Bool; public var evidence: String; public var category: String
        public init(name: String, website: String = "", used: Bool = true, evidence: String = "", category: String = "other") {
            self.name = name; self.website = website; self.used = used; self.evidence = evidence; self.category = category
        }
    }

    /// The tool-discovery agent's reply made safe, over the deterministic evidence `known`. Every catalog tool has an
    /// entry: what the agent said, else what was known, else unused. A tool found on this Mac stays used whatever it said.
    /// An extra tool's category is one of the groups' (Other when it named none it has); calendars and mail are left out.
    public static func readTools(_ text: String?, known: [String: ToolFact] = [:]) -> (tools: [ToolAnswer], additional: [ExtraTool]) {
        let value = jsonOf(text) ?? .object([:])
        var said: [String: JSONValue] = [:]
        for entry in value["tools"]?.array ?? [] {
            guard case .object = entry, let id = entry["id"]?.string, catalogIds.contains(id) else { continue }
            said[id] = entry
        }
        // A catalog tool the agent listed among the others instead (2026-10-16: Linear joined the catalog) counts as its
        // answer for that tool, when it gave none in `tools`.
        var byName: [String: String] = [:]
        for tool in catalog where byName[tool.name.lowercased()] == nil { byName[tool.name.lowercased()] = tool.id }
        let extras = value["additional"]?.array ?? []
        for entry in extras {
            guard case .object = entry, let id = byName[clip(entry["name"], 60).lowercased()], said[id] == nil else { continue }
            said[id] = ["id": .string(id), "used": .bool(entry["used"] != .bool(false)), "evidence": entry["evidence"] ?? .null]
        }
        let tools: [ToolAnswer] = catalogIds.map { id in
            let fact = known[id]
            let reply = said[id]
            let local = fact.map { $0.method == "local" && $0.used } ?? false
            let used: Bool
            if local { used = true } else if let b = reply?["used"]?.bool { used = b } else { used = fact?.used ?? false }
            var evidenceSource: Any? = ""
            if let r = reply?["evidence"], JS.truthy(r) { evidenceSource = r } else if let f = fact, !f.evidence.isEmpty { evidenceSource = f.evidence }
            let method = local ? "local" : reply != nil ? "agent" : (fact.map { $0.method.isEmpty ? "none" : $0.method } ?? "none")
            return ToolAnswer(id: id, used: used, evidence: clip(evidenceSource, 200), method: method)
        }
        var names = Set(catalog.map { $0.name.lowercased() })
        var additional: [ExtraTool] = []
        for entry in extras {
            guard case .object = entry else { continue }
            let name = clip(entry["name"], 60)
            if name.isEmpty || names.contains(name.lowercased()) || isPausedTool(name) { continue }
            names.insert(name.lowercased())
            var website = ""
            if let w = entry["website"]?.string {
                let t = w.trimmingCharacters(in: .whitespacesAndNewlines)
                if t.range(of: #"^https?://[^\s]+$"#, options: [.regularExpression, .caseInsensitive]) != nil { website = String(t.prefix(300)) }
            }
            additional.append(ExtraTool(name: name, website: website, used: entry["used"] != .bool(false), evidence: clip(entry["evidence"], 200),
                                        category: categoryOf(JS.string(entry["category"]))))
            if additional.count == 12 { break }
        }
        return (tools, additional)
    }

    // MARK: the scopes

    public struct ScopeFolder: Sendable, Equatable, Codable { public var path: String?; public var name: String?
        public init(path: String? = nil, name: String? = nil) { self.path = path; self.name = name } }

    /// What the manual import asks for a source (emptyScope's shape, with `labels` for ticked items and `projects`).
    public struct Scope: Sendable, Equatable, Codable {
        public var kind: String
        public var folders: [ScopeFolder] = []
        public var items: [String] = []
        public var people: [String] = []
        public var note: String = ""
        public var labels: [String] = []
        public var projects: [String] = []
        public init(kind: String, folders: [ScopeFolder] = [], items: [String] = [], people: [String] = [], note: String = "", labels: [String] = [], projects: [String] = []) {
            self.kind = kind; self.folders = folders; self.items = items; self.people = people; self.note = note; self.labels = labels; self.projects = projects
        }
    }

    /// folders, email, drafts, collections, repos, chats, sites or documents.
    public static func scopeKind(_ id: String) -> String {
        if ["Obsidian", "Zoom", ConnectSources.localPDFs, localFolders].contains(id) { return "folders" }
        if id == "Gmail" { return "email" }
        if id == "Overleaf" { return "drafts" }
        if id == "Zotero" { return "collections" }
        if id == "GitHub" { return "repos" }
        if groupOfApp(id) == "chats" { return "chats" }
        if id == sites { return "sites" }
        return "documents"
    }
    public static func emptyScope(_ id: String) -> Scope { Scope(kind: scopeKind(id)) }

    /// Whether a manual source says exactly what to bring in.
    public static func scopeReady(_ scope: Scope?) -> Bool {
        guard let scope else { return false }
        if scope.kind == "folders" { return !scope.folders.isEmpty }
        if scope.kind == "email" { return !scope.people.isEmpty || !scope.items.isEmpty }
        return !scope.items.isEmpty || !scope.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public struct ScopeOption: Sendable, Equatable { public var id: String; public var label: String }
    /// The options a manual source offers for the projects picked (the mockup's).
    public static func scopeOptions(_ id: String, projects: [Project]) -> [ScopeOption] {
        let kind = scopeKind(id)
        return projects.flatMap { p -> [ScopeOption] in
            switch kind {
            case "drafts": return [ScopeOption(id: "\(id):\(p.id):main", label: "\(p.title) — manuscript"), ScopeOption(id: "\(id):\(p.id):methods", label: "\(p.title) — methods draft")]
            case "email": return [ScopeOption(id: "\(id):\(p.id):collaborators", label: "Collaborator threads about \(p.title)")]
            case "collections": return [ScopeOption(id: "\(id):\(p.id)", label: "\(p.title) collection")]
            case "repos": return [ScopeOption(id: "\(id):\(p.id)", label: slug(p.title))]
            case "chats": return [ScopeOption(id: "\(id):\(p.id)", label: "\(p.title) conversations")]
            case "sites": return [ScopeOption(id: "\(id):\(p.id)", label: "Pages about \(p.title)")]
            default: return [ScopeOption(id: "\(id):\(p.id)", label: "\(p.title) documents")]
            }
        }
    }

    /// The plan an import agent is handed for one tool (the mockup's launchProjectImports): bring in only what pertains
    /// to the projects picked; a manual import keeps to the exact folders, people or items the person chose.
    /// `connector` defaults to `reachOf(app) == .connector && browser.isEmpty`.
    public static func importPlan(app: String, mode: String = "", projects: [Project], roles: [String] = [], work: String = "", scope: Scope? = nil,
                                  period: String = "", browser: String = "", connector: Bool? = nil) -> String {
        let connector = connector ?? (reachOf(app) == .connector && browser.isEmpty)
        let titles = projects.map(\.title).filter { !$0.isEmpty }
        let described = projects.map { "- \($0.title)\($0.description.isEmpty ? "" : ": \($0.description)")" }.joined(separator: "\n")
        var lines = [
            "Bring in from \(app == sites ? "the browser history" : ConnectSources.shownName(app)) only what pertains to these projects the person picked:",
            described.isEmpty ? "- \(titles.joined(separator: "\n- "))" : described,
            roles.isEmpty ? "" : "They describe their work as: \(roles.joined(separator: ", ")).",
            work.isEmpty ? "" : "In their words: \(clip(work, 600))",
            period.isEmpty ? "" : "Look back over \(period).",
            "Leave out unrelated projects, personal files, daily notes, journals, receipts and forms, and tools used every day (mail, calendar, social media) unless they are about these projects.",
        ]
        // What the person said under "Specify context" (round 3, 2026-10-13) is optional; it holds for a background run too.
        var said: [String] = []
        if let scope {
            if !scope.folders.isEmpty { said.append("only these folders and files: \(scope.folders.map { $0.path.flatMap { $0.isEmpty ? nil : $0 } ?? $0.name ?? "" }.joined(separator: "; "))") }
            if !scope.people.isEmpty { said.append("only email with these people: \(scope.people.joined(separator: "; "))") }
            if !scope.labels.isEmpty { said.append("these items: \(scope.labels.joined(separator: "; "))") }
            if !scope.projects.isEmpty { lines.append("For this source, only these of the projects: \(scope.projects.joined(separator: "; ")).") }
            if !scope.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { lines.append("In their words, what to bring in from it: \(clip(scope.note, 600))") }
        }
        if !said.isEmpty {
            lines.append("They narrowed it down: read \(said.joined(separator: ", and ")). Nothing outside it comes in, even when it looks related.")
        } else if connector {
            // A connector app is read through its own MCP server's reading tools, not a browser.
            let shown = ConnectSources.shownName(app)
            lines.append("Find what belongs with these projects yourself, through \(shown)'s own tools (its connector), only reading. If they are missing or say the sign-in ended, bring nothing in and say \(shown) needs to be connected again.")
        } else if !browser.isEmpty {
            lines.append("Find what belongs with these projects yourself, in the person's own \(browser) (their sign-ins are there) and the files on this Mac. Never install a plugin or an extension.")
        } else {
            lines.append("Find what belongs with these projects yourself, through the person's existing sign-ins in Engelbart's browser and the files on this Mac. Never install a plugin or an extension.")
        }
        return lines.filter { !$0.isEmpty }.joined(separator: "\n")
    }
}
