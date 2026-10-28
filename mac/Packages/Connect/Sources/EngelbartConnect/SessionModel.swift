import Foundation
import EngelbartCore

// The pure half of src/main/connect/session.cjs: the choose screen's answer made safe (cleanChoices, cleanDirect,
// directInput), the pinned models, the blocks every agent is handed, and the librarian's and surveys' replies made safe.

public enum ConnectModels {
    // "change the default model … to sonnet high/sol high, and do not even allow me to change model or effort, only provider"
    public static let pinned: [String: (model: String, effort: String)] = ["anthropic": ("sonnet", "high"), "openai": ("sol", "high")]
    public static let providers = ["anthropic", "openai"]
    public static let providerNames = ["anthropic": "Claude Code", "openai": "Codex"]
    static let fallbackIds: [String: (id: String, name: String)] = ["sonnet": ("claude-sonnet-5-5", "Sonnet"), "sol": ("gpt-6.1-sol", "Sol")]

    /// The pinned model of a provider, from Build's list (an id updated there carries here).
    public static func choice(_ provider: String, models: JSONValue?) -> AgentChoice {
        let at = providers.contains(provider) ? provider : "anthropic"
        let pin = pinned[at]!
        let listed = models?["providers"]?[at]?["models"]?[pin.model]
        let fallback = fallbackIds[pin.model]!
        let id = listed?["id"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? fallback.id
        let name = listed?["id"]?.string != nil ? (listed?["name"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? fallback.name) : fallback.name
        return AgentChoice(provider: at, model: pin.model, modelId: id, modelName: name, effort: pin.effort)
    }
}

public struct SourceChoice: Sendable, Equatable {
    public var on: Bool
    public var apps: [String]
    public var folders: [String]
    public var repos: [String]
    public init(on: Bool = false, apps: [String] = [], folders: [String] = [], repos: [String] = []) { self.on = on; self.apps = apps; self.folders = folders; self.repos = repos }
    public var json: JSONValue { ["on": .bool(on), "apps": .array(apps.map { .string($0) }), "folders": .array(folders.map { .string($0) }), "repos": .array(repos.map { .string($0) })] }
}

public struct ExtraTool: Sendable, Equatable {
    public var name: String, website: String, note: String, projects: [String]
    public var sites: [String] = []
    public init(name: String, website: String = "", note: String = "", projects: [String] = [], sites: [String] = []) { self.name = name; self.website = website; self.note = note; self.projects = projects; self.sites = sites }
    public var json: JSONValue { ["name": .string(name), "website": .string(website), "note": .string(note), "projects": .array(projects.map { .string($0) })] }
}

public struct DirectProject: Sendable, Equatable { public var id, title, description, folder: String
    public var json: JSONValue { ["id": .string(id), "title": .string(title), "description": .string(description), "folder": .string(folder)] } }

public struct Direct: Sendable, Equatable {
    public var mode: String
    public var projects: [DirectProject]
    public var roles: [String]
    public var work: String
    public var apps: [String]
    public var scopes: [String: ImportFlow.Scope]
    public var additional: [ExtraTool]
    var flowProjects: [ImportFlow.Project] { projects.map { ImportFlow.Project(id: $0.id, title: $0.title, description: $0.description) } }
    public var json: JSONValue {
        ["mode": .string(mode), "projects": .array(projects.map(\.json)), "roles": .array(roles.map { .string($0) }), "work": .string(work), "apps": .array(apps.map { .string($0) }),
         "scopes": .object(scopes.mapValues { s in ["kind": .string(s.kind), "folders": .array(s.folders.map { ["path": .string($0.path ?? ""), "name": .string($0.name ?? "")] }),
                                                    "people": .array(s.people.map { .string($0) }), "items": .array(s.items.map { .string($0) }), "labels": .array(s.labels.map { .string($0) }),
                                                    "projects": .array(s.projects.map { .string($0) }), "note": .string(s.note)] }),
         "additional": .array(additional.map(\.json))]
    }
}

public struct BrowserAgentsChoice: Sendable, Equatable { public var browserId: String; public var browserName: String; public var enable: Bool
    public var json: JSONValue { ["browserId": .string(browserId), "browserName": .string(browserName), "enable": .bool(enable)] } }

public struct Permissions: Sendable, Equatable { public var files: Bool, browser: Bool, recall: Bool, notes: Bool
    public var json: JSONValue { ["files": .bool(files), "browser": .bool(browser), "recall": .bool(recall), "notes": .bool(notes)] } }

/// The choose screen's answer made safe (session.cjs cleanChoices).
public struct Choices: Sendable, Equatable {
    public var sources: [String: SourceChoice]
    public var picked: [String]
    public var custom: String
    public var computer: Bool
    public var permissions: Permissions
    public var project: (name: String, description: String)?
    public var days: Int?
    public var direct: Direct?
    public var keychain: Bool
    public var browserAgents: BrowserAgentsChoice?
    public var extras: [ExtraTool]

    public static func == (a: Choices, b: Choices) -> Bool { a.json == b.json }

    public var json: JSONValue {
        ["sources": .object(sources.mapValues(\.json)), "picked": .array(picked.map { .string($0) }), "custom": .string(custom), "computer": .bool(computer),
         "permissions": permissions.json, "project": project.map { ["name": .string($0.name), "description": .string($0.description)] } ?? .null,
         "days": days.map { .number(Double($0)) } ?? .null, "direct": direct?.json ?? .null, "keychain": .bool(keychain),
         "browserAgents": browserAgents?.json ?? .null, "extras": .array(extras.map(\.json))]
    }
    /// What the scan reads (the sources, the project, the days, the permissions, the picked folders).
    var scanJSON: JSONValue {
        var o = json.object ?? [:]
        o["project"] = SessionText.projectFor(self).map { ["name": .string($0.name), "description": .string($0.description)] } ?? .null
        return .object(o)
    }
}

public enum SessionText {
    static let maxProjectName = 200
    static let maxDescription = 4000
    static let maxDirectProjects = 8
    static let askKinds: Set<String> = ["single", "multi", "open", "repos"]
    static let reposAsk = #"\bwhich\b.*\brepo(?:s|sitory|sitories)?\b"#
    static let authorizeKinds: Set<String> = ["signin", "connector", "permission", "folder"]
    static let signinApps: Set<String> = ["Zotero", "GitHub"]

    static func clip(_ text: String?, _ max: Int) -> String { let v = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines); return v.count > max ? String(v.prefix(max - 1)) + "…" : v }
    static func line(_ text: String?, _ max: Int) -> String { clip(JS.replace(text ?? "", #"\s+"#, " "), max) }
    static func line(_ v: JSONValue?, _ max: Int) -> String { line(v.map { JS.string($0) }, max) }
    static func text(_ v: JSONValue?, _ max: Int) -> String { guard let s = v?.string else { return "" }; return String(JS.replace(s, #"\s+"#, " ").trimmingCharacters(in: .whitespacesAndNewlines).prefix(max)) }

    /// The prompt in force: <dataRoot>/.context/<file> when it holds any, else the built-in one.
    public static func promptOf(_ dataRoot: String, _ file: String, _ builtIn: String) -> String {
        let custom = ((try? String(contentsOfFile: (dataRoot as NSString).appendingPathComponent(".context/\(file)"), encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return custom.isEmpty ? builtIn : custom
    }

    public static func cleanProject(_ input: JSONValue?) -> (name: String, description: String)? {
        guard let input, case .object = input else { return nil }
        let name = String((input["name"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxProjectName))
        let description = String((input["description"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxDescription))
        return name.isEmpty && description.isEmpty ? nil : (name, description)
    }

    /// The project the agents are told about: only one with a description.
    public static func projectFor(_ choices: Choices) -> (name: String, description: String)? { choices.project.flatMap { $0.description.isEmpty ? nil : $0 } }

    static func inHome(_ homeDir: String, _ value: String?) -> String? {
        guard let dir = Readers.expandPath(homeDir, value), dir.hasPrefix(homeDir + "/") else { return nil }
        return dir
    }

    static func hostOfSite(_ website: String?) -> String {
        guard let u = URL(string: website ?? ""), let s = u.scheme, s == "http" || s == "https", let h = u.host else { return "" }
        return JS.replace(h.lowercased(), #"^www\."#, "")
    }

    static func cleanExtraTools(_ value: JSONValue?) -> [ExtraTool] {
        Array((value?.array ?? []).filter { text($0["name"], 60).isEmpty == false }.prefix(12)).map { one in
            ExtraTool(name: text(one["name"], 60), website: hostOfSite(one["website"]?.string).isEmpty ? "" : String(JS.string(one["website"]).trimmingCharacters(in: .whitespacesAndNewlines).prefix(300)),
                      note: text(one["note"], 600), projects: Array((one["projects"]?.array ?? []).map { text($0, 120) }.filter { !$0.isEmpty }.prefix(maxDirectProjects)))
        }
    }

    /// Import your context's answer made safe → Direct or nil.
    public static func cleanDirect(_ input: JSONValue?, homeDir: String) -> Direct? {
        guard let input, case .object = input else { return nil }
        let mode = input["mode"]?.string == "manual" ? "manual" : "auto"
        let projects = (input["projects"]?.array ?? []).filter { !text($0["title"], 120).isEmpty }.prefix(maxDirectProjects).enumerated().map { at, one in
            DirectProject(id: text(one["id"], 64).isEmpty ? "project-\(at + 1)" : text(one["id"], 64), title: text(one["title"], 120), description: text(one["description"], 400),
                          folder: one["folder"]?.string.flatMap { inHome(homeDir, $0) } ?? "")
        }
        var apps: [String] = []
        for id in (input["apps"]?.array ?? []).compactMap(\.string) where ImportFlow.catalogIds.contains(id) && !apps.contains(id) { apps.append(id) }
        var scopes: [String: ImportFlow.Scope] = [:]
        for id in apps {
            guard let scope = input["scopes"]?[id], case .object = scope else { continue }
            let list = { (v: JSONValue?, max: Int, each: (JSONValue) -> String) in Array((v?.array ?? []).map(each).filter { !$0.isEmpty }.prefix(max)) }
            let folders = Array((scope["folders"]?.array ?? []).compactMap { f -> ImportFlow.ScopeFolder? in
                let raw = f.object != nil ? f["path"]?.string : f.string
                guard let dir = inHome(homeDir, raw) else { return nil }
                return ImportFlow.ScopeFolder(path: dir, name: (dir as NSString).lastPathComponent)
            }.prefix(12))
            scopes[id] = ImportFlow.Scope(kind: ImportFlow.scopeKind(id), folders: folders, items: list(scope["items"], 40) { text($0, 200) }, people: list(scope["people"], 20) { text($0, 200) },
                                          note: text(scope["note"], 2000), labels: list(scope["labels"], 40) { text($0, 200) }, projects: list(scope["projects"], maxDirectProjects) { text($0, 120) })
        }
        let additional = cleanExtraTools(input["additional"])
        if apps.isEmpty && additional.isEmpty { return nil }
        return Direct(mode: mode, projects: Array(projects), roles: Array((input["roles"]?.array ?? []).compactMap(\.string).filter { ImportFlow.roleNames.contains($0) }.prefix(8)),
                      work: text(input["work"], 2000), apps: apps, scopes: scopes, additional: additional)
    }

    /// Import your context's answer as the sources, folders and project Connect's pipeline runs on.
    public static func directInput(_ input: JSONValue, homeDir: String) -> JSONValue {
        guard let direct = cleanDirect(input["direct"], homeDir: homeDir) else { return input }
        var sources: [String: SourceChoice] = [:]
        for s in ConnectSources.sources { sources[s.id] = SourceChoice() }
        var picked: [String] = []
        for id in direct.apps {
            let dirs = direct.scopes[id]?.folders.compactMap(\.path) ?? []
            picked += dirs
            if id == ImportFlow.sites { sources["sites"]!.on = true; continue }
            if id == ImportFlow.localFolders { sources["code"]!.on = true; sources["code"]!.folders += dirs; continue }
            if id == "GitHub" { sources["code"]!.on = true; continue }
            guard let group = ImportFlow.groupOfApp(id), sources[group] != nil else { continue }
            sources[group]!.on = true
            sources[group]!.apps.append(id)
            if id == ConnectSources.localPDFs { sources[group]!.folders += dirs }
        }
        if !direct.additional.isEmpty { sources["sites"]!.on = true }
        for k in sources.keys { var seen: [String] = []; for f in sources[k]!.folders where !seen.contains(f) { seen.append(f) }; sources[k]!.folders = seen }
        let titles = direct.projects.map(\.title)
        var o = input.object ?? [:]
        o["sources"] = .object(sources.mapValues(\.json))
        var allPicked: [String] = []
        for p in (input["picked"]?.array?.compactMap(\.string) ?? []) + picked where !allPicked.contains(p) { allPicked.append(p) }
        o["picked"] = .array(allPicked.map { .string($0) })
        if !titles.isEmpty {
            o["project"] = ["name": .string(String(titles.joined(separator: ", ").prefix(maxProjectName))),
                            "description": .string(String(direct.projects.map { "\($0.title)\($0.description.isEmpty ? "" : ": \($0.description)")" }.joined(separator: "\n").prefix(maxDescription)))]
        }
        return .object(o)
    }

    /// An extra tool as an agent is told it: its name, its website, and what the person specified for it.
    public static func toolSaid(_ tool: ExtraTool) -> String {
        let said = [JS.replace(tool.note, #"[.\s]+$"#, ""), tool.projects.isEmpty ? "" : "only for these of the projects: \(tool.projects.joined(separator: "; "))"].filter { !$0.isEmpty }.joined(separator: "; ")
        return "\(tool.name)\(tool.website.isEmpty ? "" : " (\(tool.website))")\(said.isEmpty ? "" : ": \(said)")"
    }

    /// What the person said on the tools screen, for the librarian (a manual run's import instructions).
    public static func librarianNotes(_ direct: Direct) -> String {
        let name = { (id: String) in id == ImportFlow.sites ? "Saved URLs" : ConnectSources.shownName(id) }
        var lines: [String] = []
        if !direct.roles.isEmpty { lines.append("They describe their work as: \(direct.roles.joined(separator: ", ")).") }
        if !direct.work.isEmpty { lines.append("What they are interested in researching right now, in their words: \(direct.work)") }
        let said: [String] = direct.apps.compactMap { id in
            guard let scope = direct.scopes[id] else { return nil }
            let parts = [JS.replace(scope.note, #"[.\s]+$"#, ""),
                         scope.folders.isEmpty ? "" : "only these folders and files: \(scope.folders.compactMap(\.path).joined(separator: "; "))",
                         scope.people.isEmpty ? "" : "only with these people: \(scope.people.joined(separator: "; "))",
                         scope.projects.isEmpty ? "" : "only for these of the projects: \(scope.projects.joined(separator: "; "))"].filter { !$0.isEmpty }
            return parts.isEmpty ? nil : "- \(name(id)): \(parts.joined(separator: "; "))"
        }
        if !said.isEmpty { lines.append("What they said to bring in from each source:\n\(said.joined(separator: "\n"))") }
        if !direct.additional.isEmpty { lines.append("Other tools they use that Engelbart has no source for:\n\(direct.additional.map { "- \(toolSaid($0))" }.joined(separator: "\n"))") }
        return lines.joined(separator: "\n")
    }

    /// The choose screen's answer made safe.
    public static func cleanChoices(_ given: JSONValue, homeDir: String, alsoPicked: [String] = []) -> Choices {
        var sources: [String: SourceChoice] = [:]
        for source in ConnectSources.sources {
            guard let value = given["sources"]?[source.id], case .object = value else { sources[source.id] = SourceChoice(); continue }
            let apps = (value["apps"]?.array ?? []).compactMap(\.string).filter { source.apps.contains($0) }
            let folders = Array((value["folders"]?.array ?? []).compactMap { inHome(homeDir, $0.string) }.prefix(12))
            let repos = Array((value["repos"]?.array ?? []).compactMap(\.string).filter { JS.test($0, #"^[\w.-]{1,100}/[\w.-]{1,100}$"#) }.prefix(100))
            sources[source.id] = SourceChoice(on: JS.truthy(value["on"]), apps: apps, folders: folders, repos: repos)
        }
        let allowed = given["permissions"]
        let computer = given["computer"] != .bool(false) && allowed?["files"] != .bool(false)
        // The folders the person chose in the folder picker (MATH-110): only those among the sources' folders count.
        let chosen = Set(sources.values.flatMap(\.folders) + alsoPicked)
        var picked: [String] = []
        for dir in (given["picked"]?.array ?? []).compactMap({ Readers.expandPath(homeDir, $0.string) }) where chosen.contains(dir) && !picked.contains(dir) { picked.append(dir) }
        let ba: BrowserAgentsChoice? = {
            guard let v = given["browserAgents"], let id = v["browserId"]?.string, JS.test(id, "^[a-z]{2,20}$") else { return nil }
            let name = String(JS.replace(v["browserName"]?.string ?? "", #"[^\w .-]"#, "").trimmingCharacters(in: .whitespaces).prefix(40))
            return BrowserAgentsChoice(browserId: id, browserName: name.isEmpty ? "your browser" : name, enable: v["enable"] == .bool(true))
        }()
        return Choices(sources: sources, picked: Array(picked.prefix(40)), custom: String((given["custom"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(4000)),
                       computer: computer, permissions: Permissions(files: computer, browser: allowed?["browser"] != .bool(false), recall: allowed?["recall"] != .bool(false), notes: allowed?["notes"] == .bool(true)),
                       project: cleanProject(given["project"]), days: ConnectSources.cleanDays(given["days"]), direct: cleanDirect(given["direct"], homeDir: homeDir),
                       keychain: given["keychain"] != .bool(false), browserAgents: ba, extras: cleanExtraTools(given["extras"]))
    }

    /// The <project> block every agent is given when there is a project with a description, else nothing.
    public static func projectBlock(_ choices: Choices) -> String {
        guard let p = projectFor(choices) else { return "" }
        return "<project note=\"What the person is working on: the project this library is being connected for.\">\n\(p.name.isEmpty ? "" : "Name: \(p.name)\n")Description: \(p.description)\n</project>"
    }

    /// The <period> block surveys and imports are given (2026-10-10).
    public static func periodBlock(_ choices: Choices) -> String {
        guard let days = choices.days else { return "<period days=\"all\">All time: no limit on how far back.</period>" }
        return "<period days=\"\(days)\">Only \(ConnectSources.periodName(days)): things changed or written in the last \(days) days. The listing tools hold to it. Older items come in only when <plan> names them (by path for PDFs).</period>"
    }

    /// What an option covers (≤10 lines, ≤600 characters).
    public static func detailOf(_ value: JSONValue?) -> String {
        guard let s = value?.string else { return "" }
        let lines = JS.replace(s, #"\r\n?"#, "\n").components(separatedBy: "\n").map { JS.replace($0, #"\s+"#, " ").trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.prefix(10)
        return clip(lines.joined(separator: "\n"), 600)
    }

    /// One option of a question → { label, why, detail, checked (multi), ids } or nil.
    public static func optionOf(_ option: JSONValue, multi: Bool = false) -> JSONValue? {
        if case .object = option {
            let label = line(option["label"], 160)
            if label.isEmpty { return nil }
            var o: [String: JSONValue] = ["label": .string(label), "why": .string(line(option["why"], 140)), "detail": .string(detailOf(option["detail"]))]
            if multi { o["checked"] = .bool(option["checked"] == .bool(true)) }
            var ids: [String] = []
            for id in (option["ids"]?.array ?? []).compactMap(\.string) where !id.trimmingCharacters(in: .whitespaces).isEmpty { let l = line(id, 300); if !ids.contains(l) { ids.append(l) } }
            if !ids.isEmpty { o["ids"] = .array(ids.prefix(200).map { .string($0) }) }
            return .object(o)
        }
        let label = line(option, 160)
        if label.isEmpty { return nil }
        var o: [String: JSONValue] = ["label": .string(label), "why": "", "detail": ""]
        if multi { o["checked"] = false }
        return .object(o)
    }

    /// The librarian's reply made safe → { say, ask, authorize, dispatch, waiting, done, unread? }.
    public static func readReply(_ text: String, choices: Choices) -> JSONValue {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = JS.replace(JS.replace(raw, #"^```(?:json)?\s*"#, "", options: .caseInsensitive), #"\s*```$"#, "")
        var value: JSONValue?
        if let s = body.firstIndex(of: "{"), let e = body.lastIndex(of: "}"), s < e { value = try? JSONValue.parse(String(body[s...e])) }
        guard let value, case .object = value else {
            let say = clip(raw, 2000)
            return ["say": .string(say.isEmpty ? "…" : say), "ask": .null, "authorize": .null, "dispatch": [], "waiting": false, "done": false, "unread": true]
        }
        let on = { (id: String) in choices.sources[id]?.on == true }
        var ask: JSONValue = .null
        let a = value["ask"]
        let title = a?["title"]?.string
        let reposAsk = a?.object != nil && title != nil && (a?["kind"]?.string == "repos" || (a?["source"]?.string == "code" && a?["kind"]?.string != "open" && JS.test(title!, reposAsk, options: .caseInsensitive)))
        if reposAsk && !title!.trimmingCharacters(in: .whitespaces).isEmpty {
            ask = ["source": "code", "kind": "repos", "title": .string(line(title, 300)), "options": [], "placeholder": ""]
        } else if let a, a.object != nil, let kind = a["kind"]?.string, askKinds.contains(kind), kind != "repos", let t = title, !t.trimmingCharacters(in: .whitespaces).isEmpty {
            var options: [JSONValue] = []
            for o in (a["options"]?.array ?? []).compactMap({ optionOf($0, multi: kind == "multi") }) where !options.contains(where: { $0["label"] == o["label"] }) { options.append(o) }
            options = Array(options.prefix(10))
            let source = a["source"]?.string.flatMap { ConnectSources.sourceOf($0) != nil ? $0 : nil }
            var apps: [String] = []
            if let source { for app in (a["apps"]?.array ?? []).compactMap(\.string) where ConnectSources.sourceOf(source)!.apps.contains(app) && !apps.contains(app) { apps.append(app) } }
            if kind == "open" || !options.isEmpty {
                var o: [String: JSONValue] = ["source": source.map { .string($0) } ?? .null, "kind": .string(kind), "title": .string(line(t, 300)),
                                              "options": .array(kind == "open" ? [] : options), "placeholder": .string(kind == "open" ? line(a["placeholder"], 120) : "")]
                if !apps.isEmpty { o["apps"] = .array(apps.map { .string($0) }) }
                ask = .object(o)
            }
        }
        var authorize: JSONValue = .null
        let au = value["authorize"] ?? value["connect"] // "connect" was the first build's name for it
        if ask.isNull, let au, au.object != nil, let kind = au["kind"]?.string, authorizeKinds.contains(kind), let app = au["app"]?.string, ConnectSources.apps[app] != nil || app == "GitHub" {
            let reach = ConnectSources.apps[app]?.reach ?? .signin
            let fits = kind == "signin" ? signinApps.contains(app) : kind == "connector" ? reach == .connector : kind == "permission" ? reach == .automation : reach == .local
            if fits {
                let shown = ConnectSources.shownName(app)
                var label = line(au["label"], 60)
                if label.isEmpty { label = kind == "permission" ? "Allow Engelbart to read \(shown)" : kind == "folder" ? (app == ConnectSources.localPDFs ? "Choose a folder of PDFs…" : "Choose your \(shown) folder…") : "Sign in to \(shown)" }
                let source = au["source"]?.string.flatMap { ConnectSources.sourceOf($0) != nil ? $0 : nil } ?? ConnectSources.sourceOfApp(app)
                authorize = ["source": source.map { .string($0) } ?? .null, "app": .string(app), "kind": .string(kind), "label": .string(label)]
            }
        }
        let dispatch: [JSONValue] = (value["dispatch"]?.array ?? []).filter { e in
            guard e.object != nil, let s = e["source"]?.string, ConnectSources.sourceOf(s) != nil, on(s), let plan = e["plan"]?.string, !plan.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
            return true
        }.prefix(6).map { e in
            let s = e["source"]!.string!
            let apps = (e["apps"]?.array ?? []).compactMap(\.string).filter { ConnectSources.apps[$0] != nil || $0 == "GitHub" }.prefix(8)
            let label = line(e["label"], 80)
            return ["source": .string(s), "apps": .array(apps.map { .string($0) }), "label": .string(label.isEmpty ? ConnectSources.sourceOf(s)!.label : label), "plan": .string(clip(e["plan"]?.string, 8000))]
        }
        return ["say": .string(clip(value["say"]?.string ?? "", 2000)), "ask": ask, "authorize": authorize, "dispatch": .array(dispatch),
                "waiting": .bool(value["waiting"] == .bool(true) && ask.isNull && authorize.isNull), "done": .bool(value["done"] == .bool(true))]
    }

    /// A survey agent's report made safe; a folder search's folders kept only when inside `homeDir` and there.
    public static func readSurvey(_ text: String?, homeDir: String? = nil) -> JSONValue {
        let raw = JS.replace(JS.replace((text ?? "").trimmingCharacters(in: .whitespacesAndNewlines), #"^```(?:json)?\s*"#, "", options: .caseInsensitive), #"\s*```$"#, "")
        var value: JSONValue?
        if let s = raw.firstIndex(of: "{"), let e = raw.lastIndex(of: "}"), s < e { value = try? JSONValue.parse(String(raw[s...e])) }
        guard let value, case .object = value else { return ["signedIn": .null, "summary": .string(line(raw, 600)), "total": .null, "items": [], "notes": .null, "folders": [], "searched": .null] }
        let items: [JSONValue] = (value["items"]?.array ?? []).filter { $0.object != nil && (JS.truthy($0["id"]) || JS.truthy($0["label"])) }.prefix(40).map { i in
            let opt = { (k: String, m: Int) -> JSONValue in let s = line(i[k], m); return s.isEmpty ? .null : .string(s) }
            return ["id": .string(line(i["id"], 300)), "label": .string(line(i["label"], 160)), "kind": .string(line(i["kind"], 20)), "date": opt("date", 20), "where": opt("where", 120), "why": opt("why", 120)]
        }
        var folders: [String] = []
        if let homeDir {
            let home = FolderAccess.resolve(homeDir)
            for f in ([value["folder"]] + (value["folders"]?.array ?? []).map { Optional($0) }).compactMap({ $0?.string }) where !f.trimmingCharacters(in: .whitespaces).isEmpty {
                guard let full = Readers.expandPath(home, f), full.hasPrefix(home + "/"), Readers.isDir(full), !folders.contains(full) else { continue }
                folders.append(full)
            }
        }
        return ["signedIn": value["signedIn"]?.bool.map { .bool($0) } ?? .null, "summary": .string(line(value["summary"], 600)),
                "total": value["total"]?.double.map { .number($0) } ?? .null, "items": .array(items),
                "notes": JS.truthy(value["notes"]) ? .string(line(value["notes"], 600)) : .null, "folders": .array(folders.prefix(12).map { .string($0) }),
                "searched": JS.truthy(value["searched"]) ? .string(line(value["searched"], 300)) : .null]
    }

    /// What the person did, as the librarian is told it.
    public static func messageOf(_ input: JSONValue) -> String {
        if input["skipped"] == .bool(true) { let left = JS.string(input["left"]); return left.isEmpty ? "skipped" : "skipped: \(left) is left out for this run; nothing of it comes in" }
        if input["importNow"] == .bool(true) { return "Import now." }
        if let picked = input["picked"]?.array, !picked.isEmpty {
            let t = JS.string(input["text"])
            return "picked \(picked.map { "\"\(line($0, 160))\"" }.joined(separator: ", "))\(t.isEmpty ? "" : ", and said: \(line(t, 2000))")"
        }
        if let a = input["authorized"], a.object != nil {
            let k = JS.string(a["kind"])
            return "\(k == "permission" ? "allowed" : k == "signin" ? "signed in" : "authorized") \"\(JS.string(a["app"]))\""
        }
        if let c = input["chose"], c.object != nil { return "chose \(JS.string(c["kind"])) \"\(JS.string(c["shown"]))\" for \"\(JS.string(c["app"]))\"" }
        if let s = input["survey"]?.string { return "survey finished: \"\(s)\"" }
        return line(input["text"], 4000)
    }

    /// What the chat shows for it.
    public static func shownOf(_ input: JSONValue) -> String {
        if input["skipped"] == .bool(true) { return "Skip" }
        if input["importNow"] == .bool(true) { return "Import now" }
        if let picked = input["picked"]?.array, !picked.isEmpty {
            let t = JS.string(input["text"])
            return [picked.map { line($0, 160) }.joined(separator: ", "), t.isEmpty ? "" : clip(t, 2000)].filter { !$0.isEmpty }.joined(separator: " — ")
        }
        if let a = input["authorized"], a.object != nil {
            let app = ConnectSources.shownName(JS.string(a["app"]))
            return a["kind"]?.string == "permission" ? "Allowed \(app)" : "Signed in to \(app)"
        }
        if let c = input["chose"], c.object != nil { return JS.string(c["shown"]) }
        return clip(input["text"]?.string, 4000)
    }

    /// "ChatGPT", "ChatGPT and Claude", "ChatGPT, Claude and Gemini".
    public static func listed(_ names: [String]) -> String { names.count < 2 ? names.joined() : "\(names.dropLast().joined(separator: ", ")) and \(names.last!)" }

    /// "Skipped ChatGPT and Claude: macOS didn't allow Chrome's sign-ins. You can add them later from Add sources."
    public static func skippedLine(_ name: String, _ apps: [String]) -> String {
        "Skipped \(listed(apps.map(ConnectSources.shownName))): macOS didn't allow \(name.isEmpty ? "your browser" : name)'s sign-ins. You can add \(apps.count == 1 ? "it" : "them") later from Add sources."
    }
    /// "Left out Google Drive: not signed in. You can add it from Add sources."
    public static func leftOutLine(_ apps: [String]) -> String { "Left out \(listed(apps.map(ConnectSources.shownName))): not signed in. You can add \(apps.count == 1 ? "it" : "them") from Add sources." }

    /// What the opener says of the sign-ins brought over and the apps macOS refused.
    public static func signInLines(signedIn: [(String, String)], refused: [(String, String)]) -> String {
        var byBrowser: [(String, [String])] = []
        for (app, name) in signedIn where !name.isEmpty {
            if let i = byBrowser.firstIndex(where: { $0.0 == name }) { byBrowser[i].1.append(app) } else { byBrowser.append((name, [app])) }
        }
        var lines = byBrowser.map { "Using your \($0.0) sign-ins for \(listed($0.1.map(ConnectSources.shownName)))." }
        var skipped: [(String, [String])] = []
        for (app, name) in refused { if let i = skipped.firstIndex(where: { $0.0 == name }) { skipped[i].1.append(app) } else { skipped.append((name, [app])) } }
        lines += skipped.map { skippedLine($0.0, $0.1) }
        return lines.joined(separator: "\n")
    }
}
