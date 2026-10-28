import Foundation
import EngelbartCore
import EngelbartConnect

// Import your context (2026-10-13, the "Onboarding" workspace; src/renderer/import/ImportFlow.jsx): the flow's state
// (`F`, kept in main by importFlowSave so onboarding opened again comes back to the same step) and the pure parts of the
// flow: its words, the picker's rows, what a run is told. ImportFlowModel holds the state and does the steps.
//
//   Import context → (the provider: asked when both are subscribed; the agent popup when neither can run) → (the
//   browser's sign-ins) → What kind of work do you do? → What are you interested in researching? → What project do you
//   want to work on first? → What should go in your library? (the categories, with the tools the agents found added to
//   them) → Import to Engelbart → How should Engelbart import your sources?
//     in the background with agents → Import context using background agents (I understand) → (Allow Engelbart to
//     organize your research) → the run
//     manually, with fine-grained permissions → (Allow Engelbart to organize your research) → the librarian's chat

/// A folder or file chosen under Specify context.
public struct ScopeFile: Codable, Equatable, Sendable {
    public var path: String
    public var name: String
    public var file: Bool
    public init(path: String, name: String, file: Bool = false) { self.path = path; self.name = name; self.file = file }
}

/// What was specified for one source (emptyScope's shape, with `only`: the projects it is kept to, nil for every one).
public struct SourceScope: Codable, Equatable, Sendable {
    public var kind: String
    public var folders: [ScopeFile] = []
    public var items: [String] = []
    public var people: [String] = []
    public var note: String = ""
    public var only: [String]?
    public init(kind: String) { self.kind = kind }
}

/// A category's own context (kept from round 3; S6 took its panel away, its note and people still count).
public struct GroupScope: Codable, Equatable, Sendable {
    public var note: String = ""
    public var people: [String] = []
    public init(note: String = "", people: [String] = []) { self.note = note; self.people = people }
}

/// A project to import for: one the project agent found, or one the person added.
public struct FlowProject: Codable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var description: String = ""
    public var recent: String = ""
    public var folder: String = ""
    public init(id: String, title: String, description: String = "", recent: String = "", folder: String = "") {
        self.id = id; self.title = title; self.description = description; self.recent = recent; self.folder = folder
    }
    public init(json: JSONValue) {
        self.init(id: J.str(json["id"]), title: J.str(json["title"]), description: J.str(json["description"]), recent: J.str(json["recent"]), folder: J.str(json["folder"]))
    }
}

/// A tool outside the catalog: found by the tool agent, or added by the person ("+ Add a tool").
public struct AddedTool: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var website: String = ""
    public var source: String
    public var group: String
    public init(id: String, name: String, website: String = "", source: String, group: String) { self.id = id; self.name = name; self.website = website; self.source = source; self.group = group }
}

public struct RefusedMark: Codable, Equatable, Sendable { public var provider: String; public var since: String? }

/// The flow's state (ImportFlow.jsx `F`), saved as it is.
public struct FlowState: Codable, Equatable, Sendable {
    public var v = ImportFlowState.flowVersion
    public var screen = "intro"
    public var dialog: String?
    public var purpose: String?
    public var mode: String?
    public var scopeOpen: String?
    public var notesConsent = false
    public var agentsConsent = false
    public var librarian: String?
    public var provider: String?
    public var providerChoice: String?
    public var roles: [String] = []
    public var work = ""
    public var customProjects: [FlowProject] = []
    public var picked: [String] = []
    public var touched: [String] = []
    public var added: [AddedTool] = []
    public var picks: [String] = []
    public var open: [String] = ["notes"]
    public var period: Int? = ConnectSources.defaultPeriodDays
    public var consent = true
    public var leaves = false
    public var scopes: [String: SourceScope] = [:]
    public var groupScopes: [String: GroupScope] = [:]
    public var groupScopeClosed: [String] = []
    public var browserChoice: String?
    public var folderAnswers: [String: String]?
    public var organized = false
    public var firstProject: String?
    public var scratchName = ""
    public var scratchDesc = ""
    // Set along the way.
    public var methodFirst = false
    public var keychainNext: String?
    public var diskWaiting = false
    public var refused: RefusedMark?
    public var connectFor: String?
    public var profileChoice: String?
    public var browserFrom: String?
    public var agentsBrowser: String?
    public var agentsApps: [String] = []
    public var firstChoice: String?
    public var pickerFor: String?
    /// The project Import your context was opened over (kept with the saved flow, App.jsx's resume reads it).
    public var into: String?
    public var pendingRun: Bool?
    public init() {}

    enum CodingKeys: String, CodingKey { case v, screen, dialog, purpose, mode, scopeOpen, notesConsent, agentsConsent, librarian, provider, providerChoice, roles, work, customProjects, picked, touched, added, picks, open, period, consent, leaves, scopes, groupScopes, groupScopeClosed, browserChoice, folderAnswers, organized, firstProject, scratchName, scratchDesc, methodFirst, keychainNext, diskWaiting, refused, connectFor, profileChoice, browserFrom, agentsBrowser, agentsApps, firstChoice, pickerFor, into, pendingRun }

    /// Lenient, as `{ ...fresh(), ...saved }`: a field the saved flow lacks (or holds in a shape this build does not
    /// know) keeps fresh()'s value; a null clears an optional one (all time is `period: null`).
    public init(from decoder: Decoder) throws {
        self.init()
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let value = try? c.decode(Int.self, forKey: .v) { v = value }
        if let value = try? c.decode(String.self, forKey: .screen) { screen = value }
        if c.contains(.dialog) { dialog = (try? c.decodeIfPresent(String.self, forKey: .dialog)) ?? nil }
        if c.contains(.purpose) { purpose = (try? c.decodeIfPresent(String.self, forKey: .purpose)) ?? nil }
        if c.contains(.mode) { mode = (try? c.decodeIfPresent(String.self, forKey: .mode)) ?? nil }
        if c.contains(.scopeOpen) { scopeOpen = (try? c.decodeIfPresent(String.self, forKey: .scopeOpen)) ?? nil }
        if let value = try? c.decode(Bool.self, forKey: .notesConsent) { notesConsent = value }
        if let value = try? c.decode(Bool.self, forKey: .agentsConsent) { agentsConsent = value }
        if c.contains(.librarian) { librarian = (try? c.decodeIfPresent(String.self, forKey: .librarian)) ?? nil }
        if c.contains(.provider) { provider = (try? c.decodeIfPresent(String.self, forKey: .provider)) ?? nil }
        if c.contains(.providerChoice) { providerChoice = (try? c.decodeIfPresent(String.self, forKey: .providerChoice)) ?? nil }
        if let value = try? c.decode([String].self, forKey: .roles) { roles = value }
        if let value = try? c.decode(String.self, forKey: .work) { work = value }
        if let value = try? c.decode([FlowProject].self, forKey: .customProjects) { customProjects = value }
        if let value = try? c.decode([String].self, forKey: .picked) { picked = value }
        if let value = try? c.decode([String].self, forKey: .touched) { touched = value }
        if let value = try? c.decode([AddedTool].self, forKey: .added) { added = value }
        if let value = try? c.decode([String].self, forKey: .picks) { picks = value }
        if let value = try? c.decode([String].self, forKey: .open) { open = value }
        if c.contains(.period) { period = (try? c.decodeIfPresent(Int.self, forKey: .period)) ?? nil }
        if let value = try? c.decode(Bool.self, forKey: .consent) { consent = value }
        if let value = try? c.decode(Bool.self, forKey: .leaves) { leaves = value }
        if let value = try? c.decode([String: SourceScope].self, forKey: .scopes) { scopes = value }
        if let value = try? c.decode([String: GroupScope].self, forKey: .groupScopes) { groupScopes = value }
        if let value = try? c.decode([String].self, forKey: .groupScopeClosed) { groupScopeClosed = value }
        if c.contains(.browserChoice) { browserChoice = (try? c.decodeIfPresent(String.self, forKey: .browserChoice)) ?? nil }
        if c.contains(.folderAnswers) { folderAnswers = (try? c.decodeIfPresent([String: String].self, forKey: .folderAnswers)) ?? nil }
        if let value = try? c.decode(Bool.self, forKey: .organized) { organized = value }
        if c.contains(.firstProject) { firstProject = (try? c.decodeIfPresent(String.self, forKey: .firstProject)) ?? nil }
        if let value = try? c.decode(String.self, forKey: .scratchName) { scratchName = value }
        if let value = try? c.decode(String.self, forKey: .scratchDesc) { scratchDesc = value }
        if let value = try? c.decode(Bool.self, forKey: .methodFirst) { methodFirst = value }
        if c.contains(.keychainNext) { keychainNext = (try? c.decodeIfPresent(String.self, forKey: .keychainNext)) ?? nil }
        if let value = try? c.decode(Bool.self, forKey: .diskWaiting) { diskWaiting = value }
        if c.contains(.refused) { refused = (try? c.decodeIfPresent(RefusedMark.self, forKey: .refused)) ?? nil }
        if c.contains(.connectFor) { connectFor = (try? c.decodeIfPresent(String.self, forKey: .connectFor)) ?? nil }
        if c.contains(.profileChoice) { profileChoice = (try? c.decodeIfPresent(String.self, forKey: .profileChoice)) ?? nil }
        if c.contains(.browserFrom) { browserFrom = (try? c.decodeIfPresent(String.self, forKey: .browserFrom)) ?? nil }
        if c.contains(.agentsBrowser) { agentsBrowser = (try? c.decodeIfPresent(String.self, forKey: .agentsBrowser)) ?? nil }
        if let value = try? c.decode([String].self, forKey: .agentsApps) { agentsApps = value }
        if c.contains(.firstChoice) { firstChoice = (try? c.decodeIfPresent(String.self, forKey: .firstChoice)) ?? nil }
        if c.contains(.pickerFor) { pickerFor = (try? c.decodeIfPresent(String.self, forKey: .pickerFor)) ?? nil }
        if c.contains(.into) { into = (try? c.decodeIfPresent(String.self, forKey: .into)) ?? nil }
        if c.contains(.pendingRun) { pendingRun = (try? c.decodeIfPresent(Bool.self, forKey: .pendingRun)) ?? nil }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(v, forKey: .v)
        try c.encode(screen, forKey: .screen)
        try c.encode(dialog, forKey: .dialog)
        try c.encode(purpose, forKey: .purpose)
        try c.encode(mode, forKey: .mode)
        try c.encode(scopeOpen, forKey: .scopeOpen)
        try c.encode(notesConsent, forKey: .notesConsent)
        try c.encode(agentsConsent, forKey: .agentsConsent)
        try c.encode(librarian, forKey: .librarian)
        try c.encode(provider, forKey: .provider)
        try c.encode(providerChoice, forKey: .providerChoice)
        try c.encode(roles, forKey: .roles)
        try c.encode(work, forKey: .work)
        try c.encode(customProjects, forKey: .customProjects)
        try c.encode(picked, forKey: .picked)
        try c.encode(touched, forKey: .touched)
        try c.encode(added, forKey: .added)
        try c.encode(picks, forKey: .picks)
        try c.encode(open, forKey: .open)
        try c.encode(period, forKey: .period)
        try c.encode(consent, forKey: .consent)
        try c.encode(leaves, forKey: .leaves)
        try c.encode(scopes, forKey: .scopes)
        try c.encode(groupScopes, forKey: .groupScopes)
        try c.encode(groupScopeClosed, forKey: .groupScopeClosed)
        try c.encode(browserChoice, forKey: .browserChoice)
        try c.encode(folderAnswers, forKey: .folderAnswers)
        try c.encode(organized, forKey: .organized)
        try c.encode(firstProject, forKey: .firstProject)
        try c.encode(scratchName, forKey: .scratchName)
        try c.encode(scratchDesc, forKey: .scratchDesc)
        try c.encode(methodFirst, forKey: .methodFirst)
        try c.encode(keychainNext, forKey: .keychainNext)
        try c.encode(diskWaiting, forKey: .diskWaiting)
        try c.encode(refused, forKey: .refused)
        try c.encode(connectFor, forKey: .connectFor)
        try c.encode(profileChoice, forKey: .profileChoice)
        try c.encode(browserFrom, forKey: .browserFrom)
        try c.encode(agentsBrowser, forKey: .agentsBrowser)
        try c.encode(agentsApps, forKey: .agentsApps)
        try c.encode(firstChoice, forKey: .firstChoice)
        try c.encode(pickerFor, forKey: .pickerFor)
        try c.encode(into, forKey: .into)
        try c.encode(pendingRun, forKey: .pendingRun)
    }

    /// The saved flow (main's importFlow) → the state.
    public init(saved: JSONValue) {
        if let data = try? JSONEncoder().encode(saved), let decoded = try? JSONDecoder().decode(FlowState.self, from: data) { self = decoded } else { self.init() }
    }
    public var json: JSONValue { (try? JSONValue.parse(JSONEncoder().encode(self))) ?? .null }
}

public enum ImportFlowState {
    public static let copy: [String: String] = [
        "title": "Import your context",
        "subtitle": "Agents will import your notes, chats, and other project context into Engelbart. Everything remains local and isn't uploaded to the cloud.",
        "primary": "Import context (recommended)",
        "secondary": "Skip",
        "pickerTitle": "What should go in your library?",
        "bring": "Bring these in",
    ]
    /// 3 (2026-10-14): Import your context is a screen of its own. 4 (From Amitav, 2026-10-15): one tools screen for both
    /// ways of importing (a flow saved before starts over).
    public static let flowVersion = 4
    /// Dialogs taken out (From Amitav, 2026-10-15): a flow saved on one of them opens on what took its place.
    public static let goneDialogs: [String: String?] = ["keychain-confirm": "keychain", "privacy": nil, "apps": nil, "folders": nil, "disk-wait": nil, "disk-relaunch": nil,
                                                        "folder-fallback": nil, "folders-asking": nil, "folder-results": nil]
    /// What "Connect desktop" asks macOS for (2026-10-15, in place of Full Disk Access): one prompt each, at once.
    public static let desktopFolders = ["Desktop", "Documents", "Downloads"]
    /// The sources whose Specify context has Choose files (Obsidian's opens a picker over its vaults).
    public static let fileSources = ["Obsidian", "Zoom", "Zotero", ConnectSources.localPDFs, ImportFlow.localFolders]
    /// "Specific things to import from {app} (optional)": the hint is the category's (2026-10-14, Hudson's words).
    public static let groupHints = [
        "notes": "Only bring in notes relating to the Memex and my research",
        "transcripts": "Only bring in transcripts relating to meetings with professors on the Memex",
        "chats": "Only include the chats that discussed Memex and the history of computing",
        "sites": "Pull in the essays and paper links I've added to some of my research notes",
        "papers": "Include the papers in my local Memex folder",
        "code": "Bring in the digital Memex prototype I was hacking on last week",
        "other": "Only bring in what I made for the Memex project",
    ]
    /// Recommended (2026-10-23, Hudson: "highlight these as the most important ones"): the picker's first section. Each
    /// stays in its own category too; both rows are the one pick.
    public static let recommended = ["Claude", "ChatGPT", "Obsidian", "Notion", "Zotero"].filter { ImportFlow.catalogIds.contains($0) }
    public static let runLabel = "Import to Engelbart"
    /// Dialogs a click beside them does not close (2026-10-16: the browser's sign-ins "wasn't skippable").
    public static let unskippable = ["starting", "organize", "browser-agents", "browser-agents-confirm", "keychain", "keychain-browser", "safari", "browser-profile"]
    /// System Settings ▸ Privacy & Security ▸ Full Disk Access, opened directly when main can't (S9).
    public static let fullDiskAccessURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"

    // Websites holds a "Saved websites from {app}" row for each notes app picked (2026-10-14).
    public static let linksPrefix = "links:"
    public static func linksOf(_ app: String) -> String { linksPrefix + app }
    public static func isLinks(_ id: String) -> Bool { id.hasPrefix(linksPrefix) }
    public static func linkedApp(_ id: String) -> String { String(id.dropFirst(linksPrefix.count)) }
    public static let linksNote = "Also bring in the web links saved in these notes (essays, papers, articles and other pages): add each one to the library with add_to_library."
    public static var notesApps: [String] { ImportFlow.groups.first { $0.id == "notes" }?.apps ?? [] }

    /// The catalog's group of a source (a saved-websites row and the browser's history are Websites).
    public static func groupOf(_ id: String) -> String? {
        if isLinks(id) || id == ImportFlow.sites { return "sites" }
        return ImportFlow.groups.first { $0.apps.contains(id) }?.id
    }
    /// The category a source is shown in: the catalog's, else (a tool the agents found or the person added) its own.
    public static func groupOfId(_ id: String, _ state: FlowState) -> String { groupOf(id) ?? state.added.first { $0.id == id }?.group ?? "other" }

    /// A source's name as its row says it (a tool the agents found by its own name).
    public static func toolName(_ id: String, added: [AddedTool] = []) -> String {
        if isLinks(id) { return "Saved websites from \(toolName(linkedApp(id)))" }
        return ImportFlow.catalogTool(id)?.name ?? added.first { $0.id == id }?.name ?? id
    }
    /// A source as the Specify context lines name it ("websites saved in Obsidian").
    public static func spokenName(_ id: String, added: [AddedTool] = []) -> String { isLinks(id) ? "websites saved in \(toolName(linkedApp(id)))" : toolName(id, added: added) }

    public static func emptyScope(_ id: String) -> SourceScope { SourceScope(kind: ImportFlow.scopeKind(isLinks(id) ? ImportFlow.sites : id)) }

    /// The intro's logos (From Amitav, 2026-10-15: "get rid of the +12, just show everything"): every supported app with a
    /// logo, the mockup's eight first, each name and each picture once.
    public static var supported: [(name: String, file: String)] {
        var seenNames = Set<String>(), seenFiles = Set<String>()
        var out: [(String, String)] = []
        let all = Logos.works.map { (ConnectSources.shownName($0.app), $0.file) } + ImportFlow.catalog.compactMap { tool in Logos.toolFile(tool.id).map { (tool.name, $0) } }
        for (name, file) in all where !seenNames.contains(name) && !seenFiles.contains(file) { seenNames.insert(name); seenFiles.insert(file); out.append((name, file)) }
        return out.map { (name: $0.0, file: $0.1) }
    }

    /// The projects: the project agent's, then the person's own.
    public static func allProjects(_ state: FlowState, _ discovery: JSONValue?) -> [FlowProject] {
        J.arr(discovery?["projects"]?["projects"]).map(FlowProject.init(json:)) + state.customProjects
    }
    public static func selectedProjects(_ state: FlowState, _ discovery: JSONValue?) -> [FlowProject] { allProjects(state, discovery).filter { state.picked.contains($0.id) } }

    /// The catalog's apps a run imports from: those ticked on the tools screen.
    public static func runApps(_ state: FlowState) -> [String] { state.picks.filter { ImportFlow.catalogIds.contains($0) } }
    /// The tools the agents found (or the person added) that are ticked.
    public static func runAdded(_ state: FlowState) -> [AddedTool] { state.added.filter { state.picks.contains($0.id) } }

    /// A category's rows: its apps (Websites: the browser's saved URLs, then each notes app's saved websites), then the
    /// tools the agents found in it. Other: its own apps (Linear) and those.
    public static func keysOf(_ group: SourceGroup, _ state: FlowState) -> [String] {
        let own = (group.apps.isEmpty ? (group.id == "other" ? [] : ["__\(group.id)"]) : group.apps).map { $0 == "__sites" ? ImportFlow.sites : $0 }
        let links = group.id == "sites" ? notesApps.filter { state.picks.contains($0) }.map(linksOf) : []
        let found = state.added.filter { groupOfId($0.id, state) == group.id }.map(\.id)
        return own + links + found
    }

    /// A source ticked or unticked (the person's own, so the tool agent's answer leaves it). Ticking closes any Specify
    /// context; unticking a notes app takes its saved websites with it.
    public static func pickSource(_ state: FlowState, _ id: String) -> FlowState {
        var next = state
        let adding = !state.picks.contains(id)
        next.picks = adding ? state.picks + [id] : state.picks.filter { $0 != id }
        if !adding && notesApps.contains(id) { next.picks = next.picks.filter { $0 != linksOf(id) } }
        if !next.touched.contains(id) { next.touched.append(id) }
        next.scopeOpen = adding ? nil : (state.scopeOpen == id ? nil : state.scopeOpen)
        return next
    }

    /// The tool agent's answer (From Amitav, 2026-10-15: one tools screen): each tool it found goes to its category (Other
    /// when none fits) and, in a new user's onboarding, what it found in use is ticked unless the person touched it.
    /// From a project nothing is ticked (2026-10-14: "it should not preselect anything on manual import").
    public static func mergeTools(_ state: FlowState, results: JSONValue, tick: Bool) -> FlowState {
        var next = state
        var picks = state.picks
        func add(_ id: String) { if !picks.contains(id) { picks.append(id) } }
        for tool in J.arr(results["tools"]) {
            let id = J.str(tool["id"])
            if !tick || !ImportFlow.catalogIds.contains(id) || state.touched.contains(id) { continue }
            if J.truthy(tool["used"]) && J.truthy(tool["evidence"]) { add(id) } else { picks.removeAll { $0 == id } }
        }
        for extra in J.arr(results["additional"]) {
            let name = J.str(extra["name"])
            let id = "custom:\(name.lowercased())"
            if !next.added.contains(where: { $0.id == id }) {
                let category = J.str(extra["category"])
                next.added.append(AddedTool(id: id, name: name, website: J.str(extra["website"]), source: "agent", group: ImportFlow.groupIds.contains(category) ? category : "other"))
            }
            if tick && J.truthy(extra["used"]) && J.truthy(extra["evidence"]) && !state.touched.contains(id) { add(id) }
        }
        next.picks = picks
        return next
    }

    /// "Thing one. Thing two." from lines (each ends with a full stop).
    static func sentence(_ lines: [String]) -> String {
        lines.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.map { $0.range(of: #"[.!?]$"#, options: .regularExpression) != nil ? $0 : "\($0)." }.joined(separator: " ")
    }

    /// What an import is told, either way (From Amitav, 2026-10-15): the projects (the one to start with first), the
    /// catalog's apps ticked, what was specified for each (its own Specify context and its category's), and the extra
    /// tools ticked with theirs.
    public static func runChoices(_ state: FlowState, _ discovery: JSONValue?) -> (projects: [JSONValue], apps: [String], scopes: JSONValue, additional: [JSONValue]) {
        let chosen = selectedProjects(state, discovery)
        let projects = chosen.enumerated().sorted { a, b in
            let fa = a.element.id == state.firstProject, fb = b.element.id == state.firstProject
            return fa != fb ? fa : a.offset < b.offset
        }.map(\.element)
        func titlesOf(_ ids: [String]) -> [String] { projects.filter { ids.contains($0.id) }.map(\.title) }
        func said(_ id: String, _ group: String) -> (scope: SourceScope, category: GroupScope, only: [String]) {
            let scope = state.scopes[id] ?? emptyScope(id)
            let category = state.groupScopes[group] ?? GroupScope()
            let only = scope.only.map(titlesOf) ?? []
            return (scope, category, only.count == projects.count ? [] : only)
        }
        let apps = runApps(state)
        var scopes: [String: JSONValue] = [:]
        for id in apps {
            let (scope, category, only) = said(id, groupOf(id) ?? "other")
            let links = state.picks.contains(linksOf(id))
            let linkScope = state.scopes[linksOf(id)]
            let sites = links ? (state.groupScopes["sites"] ?? GroupScope()) : nil
            let note = sentence([category.note, scope.note, links ? linksNote : "", (sites?.note ?? "").isEmpty ? "" : "For those links: \(sites!.note)",
                                 (linkScope?.note ?? "").isEmpty ? "" : "For those links: \(linkScope!.note)"])
            var people: [String] = []
            for p in category.people + scope.people where !people.contains(p) { people.append(p) }
            scopes[id] = ["kind": .string(scope.kind), "folders": .array(scope.folders.map { ["path": .string($0.path), "name": .string($0.name), "file": .bool($0.file)] }),
                          "note": .string(note), "people": .array(people.map(JSONValue.string)), "items": [], "labels": [], "projects": .array(only.map(JSONValue.string))]
        }
        let additional: [JSONValue] = runAdded(state).map { tool in
            let (scope, category, only) = said(tool.id, tool.group.isEmpty ? "other" : tool.group)
            return ["name": .string(tool.name), "website": .string(tool.website), "note": .string(sentence([category.note, scope.note])), "projects": .array(only.map(JSONValue.string))]
        }
        return (projects.map { ["id": .string($0.id), "title": .string($0.title), "description": .string($0.description), "folder": .string($0.folder)] }, apps, .object(scopes), additional)
    }

    /// What `connect-start` is sent, either way.
    public static func startInput(_ state: FlowState, provider: String, choices: (projects: [JSONValue], apps: [String], scopes: JSONValue, additional: [JSONValue]),
                                  browsers: JSONValue?, mode: ImportFlowMode, into: String?, workspaceId: String?, librarian: Bool = false) -> JSONValue {
        var out: [String: JSONValue] = [
            "provider": .string(provider),
            "permissions": ["files": true, "browser": true, "recall": true, "notes": .bool(choices.apps.contains("Apple Notes"))],
            // S11: from the answer alone; declined or never answered, macOS is never asked
            "keychain": .bool(OnboardingHelpers.runKeychain(browsers)),
            "browser": browsers?["chosenId"].flatMap { $0.string.map(JSONValue.string) } ?? .null,
            "days": ConnectSources.cleanDays(state.period).map { .number(Double($0)) } ?? .null,
            "direct": ["mode": .string(state.mode ?? "auto"), "projects": .array(choices.projects), "roles": .array(state.roles.map(JSONValue.string)), "work": .string(state.work),
                       "apps": .array(choices.apps.map(JSONValue.string)), "scopes": choices.scopes, "additional": .array(choices.additional)],
        ]
        if mode == .modal, let into, !into.isEmpty {
            out["projectId"] = .string(into)
            if let workspaceId, !workspaceId.isEmpty { out["workspaceId"] = .string(workspaceId) }
        }
        if librarian { out["librarian"] = true }
        return .object(out)
    }

    public struct DiscoveryLine: Equatable, Sendable {
        public var status: String
        public var text: String
        /// "Connect Claude Code" / "Connect Codex" / "Connect Claude Code or Codex", with the provider it asks for.
        public var connect: String?
        public var connectProvider: String?
        /// Its CLI says it is signed in, yet turned the agent away: connecting is signing in again.
        public var refused: Bool
        public var tryAgain: Bool
    }

    /// The recent projects' line (2026-10-14, a beta tester: "it said try again but it didn't work ever"): a failure its
    /// provider's CLI caused asks to connect that one; a search that never started says so instead of "Finding…". nil when
    /// nothing was asked for and no provider is known.
    public static func discoveryLine(_ discovery: JSONValue?, providers: JSONValue?, provider: String?) -> DiscoveryLine? {
        let found = discovery?["projects"]
        let status = found.map { J.str($0["status"]) }.flatMap { $0.isEmpty ? nil : $0 } ?? "idle"
        if status == "idle" && (provider ?? "").isEmpty { return nil }
        let connect = ["anthropic", "openai"].contains(J.str(found?["connect"])) ? J.str(found?["connect"]) : nil
        let named = connect == "openai" ? "Codex" : connect == "anthropic" ? "Claude Code" : ""
        let refused = status == "failed" && connect != nil && J.arr(providers?["providers"]).contains { J.str($0["id"]) == connect && J.truthy($0["installed"]) && J.truthy($0["signedIn"]) }
        let asking = J.strs(found?["asking"])
        let text: String
        if status == "done" && J.truthy(found?["empty"]) { text = "No recent projects found. Add your own below." }
        else if status == "done" { text = "Recent projects found" }
        // DISCOVERY's route (2026-10-16): the person's Claude or ChatGPT on the web is asked when the CLIs knew nothing.
        else if status == "running" && !asking.isEmpty { text = "Asking \(asking.joined(separator: " and ")) about your projects…" }
        else if status == "running" { text = "Finding recent projects in the background…" }
        else if status == "failed" { text = connect != nil ? "Couldn’t reach \(named)." : "Couldn’t find recent projects. Add your own below." }
        else if status == "waiting-provider" { text = "Waiting for \(named.isEmpty ? "your AI provider" : named)…" }
        else if status == "stale" || status == "idle" { text = "Recent projects weren’t looked for." }
        else { text = "Finding recent projects in the background…" }
        let showsConnect = status == "waiting-provider" || (status == "failed" && connect != nil)
        let showsAgain = (status == "failed" && connect == nil) || status == "stale" || status == "idle"
        return DiscoveryLine(status: status, text: text, connect: showsConnect ? (named.isEmpty ? "Connect Claude Code or Codex" : "Connect \(named)") : nil,
                             connectProvider: connect, refused: refused, tryAgain: showsAgain)
    }

    /// The Specify context of a source: the projects it is kept to (nil: every one picked), toggled; never none.
    public static func toggleOnly(_ scope: SourceScope, project: String, every: [String]) -> [String]?? {
        let only = scope.only.map { $0.filter(every.contains) }
        let now = (only?.isEmpty ?? true) ? every : only!
        let on = now.contains(project)
        let next = on ? now.filter { $0 != project } : (now.contains(project) ? now : now + [project])
        if next.isEmpty { return .none } // a source is for one project at least
        return .some(next.count == every.count ? nil : next)
    }
}

/// Import your context's two places: a new user's onboarding (the whole window) or over a workspace (a modal, into a
/// project).
public enum ImportFlowMode: String, Sendable { case new, modal }
