import Foundation
import EngelbartCore

/// `<dataRoot>/state.json` (projects.cjs): where the app reopens, the windows, each workspace's view, each project's Stage
/// tabs, the recent workspaces and agents, stars and folders. `write` MERGES: every field it held is kept.
public enum AppState {
    static let file = "state.json"
    static let lock = NSRecursiveLock()

    static func path(_ dataRoot: String) -> String { Paths.join(dataRoot, file) }

    public static func read(_ dataRoot: String) -> [String: JSONValue] {
        JSONFiles.read(path(dataRoot))?.object ?? [:]
    }

    /// Rewrites state.json with the fields given; every other field kept (a topic-era `topicId` becomes `workspaceId`).
    public static func write(_ dataRoot: String, _ patch: [String: JSONValue]) throws {
        lock.lock(); defer { lock.unlock() }
        var held = read(dataRoot)
        held["topicId"] = nil; held["goalId"] = nil
        let last = readLastOpen(dataRoot)
        held["projectId"] = last.projectId.map { .string($0) } ?? .null
        held["workspaceId"] = last.workspaceId.map { .string($0) } ?? .null
        for (k, v) in patch { held[k] = v }
        try JSONFiles.makeDir(dataRoot)
        try JSONFiles.write(path(dataRoot), .object(held))
    }

    static func idOrNull(_ v: JSONValue?) -> String? { Ids.idOrNull(v) }
    static func isoOrNull(_ v: JSONValue?) -> String? {
        guard let s = v?.string, s.count <= 40, JSDate.parse(s) != nil else { return nil }
        return s
    }

    // MARK: last open

    public struct LastOpen: Codable, Equatable, Sendable {
        public var projectId: String?
        public var workspaceId: String?
        public init(projectId: String?, workspaceId: String?) { self.projectId = projectId; self.workspaceId = workspaceId }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(projectId, forKey: .projectId); try c.encode(workspaceId, forKey: .workspaceId)
        }
        enum CodingKeys: String, CodingKey { case projectId, workspaceId }
    }

    public static func readLastOpen(_ dataRoot: String) -> LastOpen {
        let value = read(dataRoot)
        return LastOpen(projectId: idOrNull(value["projectId"]), workspaceId: idOrNull(value["workspaceId"]) ?? idOrNull(value["topicId"]))
    }

    @discardableResult
    public static func writeLastOpen(_ dataRoot: String, _ value: JSONValue?) throws -> LastOpen {
        let next = LastOpen(projectId: idOrNull(value?["projectId"]), workspaceId: idOrNull(value?["workspaceId"]))
        try write(dataRoot, ["projectId": next.projectId.map { .string($0) } ?? .null, "workspaceId": next.workspaceId.map { .string($0) } ?? .null])
        return next
    }

    // MARK: windows (2026-10-03)

    static let maxWindows = 24

    static func cleanBounds(_ value: JSONValue?) -> JSONValue {
        guard let input = value?.object else { return .null }
        var out: [String: JSONValue] = [:]
        for key in ["x", "y", "width", "height"] {
            let n: Double
            switch input[key] {
            case .number(let d)?: n = d
            case .string(let s)?: guard let d = Double(s.trimmingCharacters(in: .whitespaces)) else { return .null }; n = d
            case .bool(let b)?: n = b ? 1 : 0
            case .null?: n = 0
            default: return .null
            }
            if !n.isFinite || abs(n) > 100000 { return .null }
            out[key] = .number((n + 0.5).rounded(.down))
        }
        return (out["width"]!.double! >= 100 && out["height"]!.double! >= 100) ? .object(out) : .null
    }

    static func cleanWindows(_ value: JSONValue?) -> [JSONValue] {
        var out: [JSONValue] = []
        for entry in value?.array ?? [] {
            guard entry.isPlainObject else { continue }
            let projectId = idOrNull(entry["projectId"])
            out.append(["projectId": projectId.map { .string($0) } ?? .null,
                        "workspaceId": projectId != nil ? (idOrNull(entry["workspaceId"]).map { .string($0) } ?? .null) : .null,
                        "bounds": cleanBounds(entry["bounds"])])
        }
        return Array(out.suffix(maxWindows))
    }

    /// The windows open when the app last kept them, the one focused last at the end.
    public static func readWindows(_ dataRoot: String) -> [JSONValue] { cleanWindows(read(dataRoot)["windows"]) }

    @discardableResult
    public static func writeWindows(_ dataRoot: String, _ list: JSONValue) throws -> [JSONValue] {
        let windows = cleanWindows(list)
        try write(dataRoot, ["windows": .array(windows)])
        return windows
    }

    // MARK: views (2026-09-22)

    static let maxTabs = 40
    static let maxPositions = 200

    /// { top, line?, offset?, hash? }
    static func cleanPosition(_ value: JSONValue?) -> JSONValue? {
        guard let input = value?.object, let top = input["top"]?.double, top.isFinite else { return nil }
        var out: [String: JSONValue] = ["top": .number(jsRound(min(1e7, max(0, top))))]
        if let line = input["line"]?.double, line.rounded() == line, line >= 0, line < 1e6 {
            out["line"] = .number(line)
            let offset = input["offset"]?.double.flatMap { $0.isFinite ? $0 : nil }
            out["offset"] = .number(offset.map { jsRound(min(1e6, max(-1e6, $0))) } ?? 0)
            if let hash = input["hash"]?.string, Projects.matches(hash, "^[0-9a-z]{1,16}$") { out["hash"] = .string(hash) }
        }
        return .object(out)
    }

    /// Math.round (halves toward +∞).
    static func jsRound(_ n: Double) -> Double { (n + 0.5).rounded(.down) }

    static func cleanView(_ value: JSONValue?) -> JSONValue? {
        guard let input = value?.object else { return nil }
        var tabs: [JSONValue] = [], seen: [String] = []
        for tab in input["tabs"]?.array ?? [] {
            guard let id = idOrNull(tab["id"]), !seen.contains(id) else { continue }
            seen.append(id)
            var clean: [String: JSONValue] = ["id": .string(id), "title": .string(String((tab["title"]?.string ?? "").prefix(200)))]
            if tab["kind"]?.string == "workspace" { clean["kind"] = "workspace" } // another workspace's document open here as a tab (2026-09-23)
            tabs.append(.object(clean))
            if tabs.count >= maxTabs { break }
        }
        var positions: [String: JSONValue] = [:]
        let entries = (input["positions"]?.object ?? [:]).sorted { $0.key < $1.key }.suffix(maxPositions)
        for (key, position) in entries {
            guard let range = key.range(of: "^(ws|note):(.+)$", options: .regularExpression), range.lowerBound == key.startIndex else { continue }
            let colon = key.firstIndex(of: ":")!
            let id = String(key[key.index(after: colon)...])
            guard Ids.isUUID(id), let clean = cleanPosition(position) else { continue }
            positions[key] = clean
        }
        let activeRaw = input["active"]
        let active: String = (activeRaw?.string != "ws" && idOrNull(activeRaw).map(seen.contains) == true) ? activeRaw!.string! : "ws"
        return ["active": .string(active), "tabs": .array(tabs), "positions": .object(positions)]
    }

    /// What each workspace of a project had open → { workspaceId: { active, tabs, positions } }.
    public static func readViews(_ dataRoot: String, _ projectId: String?) -> [String: JSONValue] {
        guard let id = Ids.idOrNull(projectId) else { return [:] }
        let mine = read(dataRoot)["views"]?[id]?.object ?? [:]
        var out: [String: JSONValue] = [:]
        for (workspaceId, view) in mine { if Ids.isUUID(workspaceId), let clean = cleanView(view) { out[workspaceId] = clean } }
        return out
    }

    @discardableResult
    public static func writeView(_ dataRoot: String, _ projectId: String?, _ workspaceId: String?, _ view: JSONValue?) throws -> JSONValue {
        guard let pid = Ids.idOrNull(projectId), let wid = Ids.idOrNull(workspaceId) else { throw StoreError.type("a view needs a project id and a workspace id") }
        guard let clean = cleanView(view) else { throw StoreError.type("view is invalid") }
        lock.lock(); defer { lock.unlock() }
        var views = read(dataRoot)["views"]?.object ?? [:]
        var mine = views[pid]?.object ?? [:]
        mine[wid] = clean
        views[pid] = .object(mine)
        try write(dataRoot, ["views": .object(views)])
        return clean
    }

    // MARK: Stage tabs (MATH-10)

    static let maxStageTabs = 15
    static let maxAddress = 2048

    /// A place a Stage tab can go back to: http, https or file, or an absolute path; never about:.
    static func cleanAddress(_ value: JSONValue?) -> String? {
        guard let raw = value?.string else { return nil }
        let address = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if address.isEmpty || address.count > maxAddress || address.lowercased().hasPrefix("about:") { return nil }
        return (address.range(of: "^(https?|file):", options: [.regularExpression, .caseInsensitive]) != nil || address.hasPrefix("/")) ? address : nil
    }

    /// { active, tabs }: entries that are neither a row nor a place go, and the second of two that are one.
    public static func cleanStage(_ value: JSONValue?) -> JSONValue? {
        guard let input = value?.object else { return nil }
        var tabs: [JSONValue] = [], seen: [String: Int] = [:], at: [Int: Int] = [:]
        for (i, tab) in (input["tabs"]?.array ?? []).enumerated() {
            guard tab.isPlainObject else { continue }
            let item = idOrNull(tab["item"])
            let address = item == nil ? cleanAddress(tab["address"]) : nil
            if item == nil && address == nil { continue }
            let key = item.map { "i:\($0)" } ?? "l:\(AddressKey.key(address!.hasPrefix("/") ? "file://\(address!)" : address!))"
            if let kept = seen[key] { at[i] = kept; continue }
            if tabs.count >= maxStageTabs { continue }
            seen[key] = tabs.count
            at[i] = tabs.count
            let title = String((tab["title"]?.string ?? "").prefix(200))
            tabs.append(item.map { ["item": .string($0), "title": .string(title)] } ?? ["address": .string(address!), "title": .string(title)])
        }
        var wanted = 0
        if let d = input["active"]?.double, d.rounded() == d { wanted = Int(d) }
        let active = at[wanted] ?? max(0, min(wanted, tabs.count - 1))
        return ["active": .number(Double(active)), "tabs": .array(tabs)]
    }

    public static func readStage(_ dataRoot: String, _ projectId: String?) -> JSONValue {
        let held = Ids.idOrNull(projectId).flatMap { read(dataRoot)["stages"]?[$0] }
        return cleanStage(held) ?? ["active": 0, "tabs": []]
    }

    @discardableResult
    public static func writeStage(_ dataRoot: String, _ projectId: String?, _ value: JSONValue?) throws -> JSONValue {
        guard let pid = Ids.idOrNull(projectId) else { throw StoreError.type("a Stage needs a project id") }
        guard let clean = cleanStage(value) else { throw StoreError.type("stage is invalid") }
        lock.lock(); defer { lock.unlock() }
        var stages = read(dataRoot)["stages"]?.object ?? [:]
        stages[pid] = clean
        try write(dataRoot, ["stages": .object(stages)])
        return clean
    }

    /// A project purged from the trash: its views, Stage, recent workspaces, agents and stars go.
    public static func forgetProject(_ dataRoot: String, _ projectId: String) throws {
        lock.lock(); defer { lock.unlock() }
        let state = read(dataRoot)
        var patch: [String: JSONValue] = [:]
        for key in ["views", "stages", "starred"] {
            if var held = state[key]?.object, held[projectId] != nil { held[projectId] = nil; patch[key] = .object(held) }
        }
        for key in ["recent", "agents"] {
            let list = state[key]?.array ?? []
            if list.contains(where: { $0["projectId"]?.string == projectId }) { patch[key] = .array(list.filter { $0["projectId"]?.string != projectId }) }
        }
        if !patch.isEmpty { try write(dataRoot, patch) }
    }

    // MARK: starred (2026-10-07)

    static let maxStarred = 500

    static func starredIds(_ value: JSONValue?) -> [String] {
        var out: [String] = []
        for item in value?.array ?? [] { if let id = idOrNull(item), !out.contains(id) { out.append(id) } }
        return Array(out.suffix(maxStarred))
    }

    public static func readStarred(_ dataRoot: String, _ projectId: String?) -> [String] {
        guard let id = Ids.idOrNull(projectId) else { return [] }
        return starredIds(read(dataRoot)["starred"]?[id])
    }

    /// Stars an item in a project (`on`), or takes its star off. → the project's starred ids.
    @discardableResult
    public static func setStarred(_ dataRoot: String, _ projectId: String?, _ itemId: String?, _ on: Bool) throws -> [String] {
        guard let pid = Ids.idOrNull(projectId), let iid = Ids.idOrNull(itemId) else { throw StoreError.type("a star needs a project id and a library id") }
        lock.lock(); defer { lock.unlock() }
        var all = read(dataRoot)["starred"]?.object ?? [:]
        let held = starredIds(all[pid]).filter { $0 != iid }
        let next = on ? starredIds(.array((held + [iid]).map { .string($0) })) : held
        all[pid] = .array(next.map { .string($0) })
        try write(dataRoot, ["starred": .object(all)])
        return next
    }

    // MARK: folders (2026-10-13)

    public struct Folder: Codable, Equatable, Sendable {
        public var id: String
        public var name: String
        public var items: [String]
        public var created: String?
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id); try c.encode(name, forKey: .name); try c.encode(items, forKey: .items); try c.encode(created, forKey: .created)
        }
        enum CodingKeys: String, CodingKey { case id, name, items, created }
        var json: JSONValue { ["id": .string(id), "name": .string(name), "items": .array(items.map { .string($0) }), "created": created.map { .string($0) } ?? .null] }
    }

    static let maxFolders = 200
    static let maxFolderItems = 2000
    static let folderNameMax = 120

    static func cleanFolders(_ value: JSONValue?) -> [Folder] {
        var out: [Folder] = []
        for entry in value?.array ?? [] {
            let id = idOrNull(entry["id"])
            let name = entry["name"]?.string.map { String(Names.sanitizeName($0).prefix(folderNameMax)) } ?? ""
            guard let id, !name.isEmpty, !out.contains(where: { $0.id == id }) else { continue }
            var items: [String] = []
            for item in entry["items"]?.array ?? [] { if let i = idOrNull(item), !items.contains(i) { items.append(i) } }
            out.append(Folder(id: id, name: name, items: Array(items.suffix(maxFolderItems)), created: isoOrNull(entry["created"])))
            if out.count >= maxFolders { break }
        }
        return out
    }

    public static func readFolders(_ dataRoot: String) -> [Folder] { cleanFolders(read(dataRoot)["folders"]) }

    @discardableResult
    static func writeFolders(_ dataRoot: String, _ folders: [Folder]) throws -> [Folder] {
        let next = cleanFolders(.array(folders.map(\.json)))
        try write(dataRoot, ["folders": .array(next.map(\.json))])
        return next
    }

    static func folderAt(_ folders: [Folder], _ folderId: String?) throws -> Int {
        guard let id = Ids.idOrNull(folderId), let at = folders.firstIndex(where: { $0.id == id }) else { throw StoreError("Unknown folder") }
        return at
    }

    /// A new folder, named; it starts empty. → (folder, folders)
    public static func createFolder(_ dataRoot: String, _ name: String) throws -> (folder: Folder, folders: [Folder]) {
        let given = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !given.isEmpty else { throw StoreError.type("A folder needs a name") }
        lock.lock(); defer { lock.unlock() }
        let folders = readFolders(dataRoot)
        if folders.count >= maxFolders { throw StoreError.range("At most \(maxFolders) folders") }
        let folder = Folder(id: IDs.new(), name: String(Names.sanitizeName(given).prefix(folderNameMax)), items: [], created: Time.iso())
        return (folder, try writeFolders(dataRoot, folders + [folder]))
    }

    public static func renameFolder(_ dataRoot: String, _ folderId: String, _ name: String) throws -> [Folder] {
        let given = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !given.isEmpty else { throw StoreError.type("A folder needs a name") }
        lock.lock(); defer { lock.unlock() }
        var folders = readFolders(dataRoot)
        let at = try folderAt(folders, folderId)
        folders[at].name = String(Names.sanitizeName(given).prefix(folderNameMax))
        return try writeFolders(dataRoot, folders)
    }

    public static func deleteFolder(_ dataRoot: String, _ folderId: String) throws -> [Folder] {
        lock.lock(); defer { lock.unlock() }
        var folders = readFolders(dataRoot)
        folders.remove(at: try folderAt(folders, folderId))
        return try writeFolders(dataRoot, folders)
    }

    /// Library items into a folder, after what it holds; one it holds already stays where it is.
    public static func addToFolder(_ dataRoot: String, _ folderId: String, _ ids: [String]) throws -> [Folder] {
        lock.lock(); defer { lock.unlock() }
        var folders = readFolders(dataRoot)
        let at = try folderAt(folders, folderId)
        for id in ids.compactMap(Ids.idOrNull) where !folders[at].items.contains(id) { folders[at].items.append(id) }
        return try writeFolders(dataRoot, folders)
    }

    public static func removeFromFolder(_ dataRoot: String, _ folderId: String, _ id: String) throws -> [Folder] {
        lock.lock(); defer { lock.unlock() }
        var folders = readFolders(dataRoot)
        let at = try folderAt(folders, folderId)
        let gone = Ids.idOrNull(id)
        folders[at].items.removeAll { $0 == gone }
        return try writeFolders(dataRoot, folders)
    }

    // MARK: where to next (2026-09-22)

    static let recentKeep = 3
    static let recentWindowMs = 30.0 * 60 * 1000
    static let maxRecent = 100
    static let maxAgents = 50
    public static let agentKinds: Set<String> = ["bart", "brainstorm", "discover", "create", "build"]
    static let agentStatuses: Set<String> = ["running", "waiting"]
    /// Ids of the agents running in this process: a `running` row from an earlier run of the app is not read.
    nonisolated(unsafe) static var liveAgents = Set<String>()

    /// Newest first, once each: the first three whatever their age, then any other written in during the last 30 minutes.
    static func cleanRecent(_ value: JSONValue?, now: Date = Date()) -> [JSONValue] {
        var out: [JSONValue] = []
        for entry in value?.array ?? [] {
            guard let projectId = idOrNull(entry["projectId"]), let workspaceId = idOrNull(entry["workspaceId"]), let at = isoOrNull(entry["at"]) else { continue }
            if out.contains(where: { $0["projectId"]?.string == projectId && $0["workspaceId"]?.string == workspaceId }) { continue }
            if out.count >= recentKeep, let when = JSDate.parse(at), !(now.timeIntervalSince(when) * 1000 <= recentWindowMs) { continue }
            out.append(["projectId": .string(projectId), "workspaceId": .string(workspaceId), "at": .string(at)])
            if out.count >= maxRecent { break }
        }
        return out
    }

    /// A highlight on a pdf (MATH-27) or a web page (MATH-54), a note or a workspace document; else nil.
    public static func cleanDocRef(_ value: JSONValue?) -> JSONValue? {
        guard let input = value, input.isPlainObject else { return nil }
        let kind = input["kind"]?.string
        if kind == "workspace", let id = idOrNull(input["workspaceId"]) { return ["kind": "workspace", "workspaceId": .string(id)] }
        if kind == "note", let id = idOrNull(input["id"]) { return ["kind": "note", "id": .string(id)] }
        let web = input["source"]?.string == "web" && (input["page"] == nil || input["page"]?.isNull == true)
        if kind == "mark", let id = input["id"]?.string, Projects.matches(id, #"^[\w-]{1,64}$"#) {
            let page = input["page"]?.double
            guard web || (page.map { $0.rounded() == $0 && $0 > 0 } ?? false) else { return nil }
            var out: [String: JSONValue] = ["kind": "mark", "id": .string(id)]
            if web { out["source"] = "web" } else { out["page"] = .number(page!) }
            if let row = idOrNull(input["rowId"]) { out["rowId"] = .string(row); return .object(out) }
            if let url = input["url"]?.string, !url.isEmpty, url.count <= 8192 { out["url"] = .string(url); return .object(out) }
        }
        return nil
    }

    static func cleanAgents(_ value: JSONValue?) -> [JSONValue] {
        var out: [JSONValue] = []
        lock.lock(); let live = liveAgents; lock.unlock()
        for entry in value?.array ?? [] {
            guard entry.isPlainObject, let id = entry["id"]?.string, Projects.matches(id, #"^[\w-]{1,64}$"#),
                  let kind = entry["kind"]?.string, agentKinds.contains(kind), let status = entry["status"]?.string, agentStatuses.contains(status),
                  !out.contains(where: { $0["id"]?.string == id }) else { continue }
            if status == "running" && !live.contains(id) { continue }
            out.append(["id": .string(id), "kind": .string(kind), "projectId": idOrNull(entry["projectId"]).map { .string($0) } ?? .null,
                        "workspaceId": idOrNull(entry["workspaceId"]).map { .string($0) } ?? .null, "doc": cleanDocRef(entry["doc"]) ?? .null,
                        "status": .string(status), "started": isoOrNull(entry["started"]).map { .string($0) } ?? .null,
                        "finished": isoOrNull(entry["finished"]).map { .string($0) } ?? .null])
        }
        return Array(out.suffix(maxAgents))
    }

    /// The recent workspaces and the agents, each with the names it is shown by; an entry whose project or workspace is
    /// gone is left out. → { recent, agents }
    public static func readNav(_ ctx: StoreContext) -> JSONValue {
        let state = read(ctx.dataRoot)
        var places: [String: (name: String, byId: [String: FlatWorkspace])?] = [:]
        func place(_ projectId: String, _ workspaceId: String) -> [String: JSONValue]? {
            if places[projectId] == nil {
                if let project = try? Projects.find(ctx, projectId) {
                    places[projectId] = .some((project.name, Dictionary(Workspaces.flatten(project.dir).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })))
                } else { places[projectId] = .some(nil) }
            }
            guard let project = places[projectId] ?? nil, let workspace = project.byId[workspaceId] else { return nil }
            return ["name": .string(workspace.name), "path": .string(workspace.path), "projectName": .string(project.name)]
        }
        let recent = cleanRecent(state["recent"]).compactMap { entry -> JSONValue? in
            place(entry["projectId"]!.string!, entry["workspaceId"]!.string!).map { entry.merging($0) }
        }
        let agents = cleanAgents(state["agents"]).compactMap { agent -> JSONValue? in
            guard let workspaceId = agent["workspaceId"]?.string else { return agent }
            guard let projectId = agent["projectId"]?.string, let at = place(projectId, workspaceId) else { return nil }
            return agent.merging(at)
        }
        return ["recent": .array(recent), "agents": .array(agents)]
    }

    /// A workspace was written in (or made): it moves to the front of `recent`.
    @discardableResult
    public static func recordEdit(_ ctx: StoreContext, _ projectId: String, _ workspaceId: String) throws -> [JSONValue] {
        _ = try Workspaces.find(ctx, projectId, workspaceId)
        lock.lock(); defer { lock.unlock() }
        let held = read(ctx.dataRoot)["recent"]?.array ?? []
        let recent = cleanRecent(.array([["projectId": .string(projectId), "workspaceId": .string(workspaceId), "at": .string(Time.iso())]] + held))
        try write(ctx.dataRoot, ["recent": .array(recent)])
        return recent
    }

    static func writeAgents(_ dataRoot: String, _ change: ([JSONValue]) -> [JSONValue]) throws {
        lock.lock(); defer { lock.unlock() }
        let agents = change(cleanAgents(read(dataRoot)["agents"]))
        try write(dataRoot, ["agents": .array(Array(agents.suffix(maxAgents)))])
    }

    /// An agent starts: `running`, in the workspace it was asked from.
    public static func agentStarted(_ dataRoot: String, id: String, kind: String = "bart", projectId: String?, workspaceId: String? = nil, doc: JSONValue? = nil) throws {
        guard Projects.matches(id, #"^[\w-]{1,64}$"#), agentKinds.contains(kind) else { throw StoreError.type("agent is invalid") }
        lock.lock(); liveAgents.insert(id); lock.unlock()
        try writeAgents(dataRoot) { agents in
            agents.filter { $0["id"]?.string != id } + [["id": .string(id), "kind": .string(kind), "projectId": Ids.idOrNull(projectId).map { .string($0) } ?? .null,
                                                        "workspaceId": Ids.idOrNull(workspaceId).map { .string($0) } ?? .null, "doc": cleanDocRef(doc) ?? .null,
                                                        "status": "running", "started": .string(Time.iso()), "finished": .null]]
        }
    }

    /// It finished (an answer or a failure): `waiting` until its workspace is visited.
    public static func agentFinished(_ dataRoot: String, _ id: String) throws {
        try writeAgents(dataRoot) { agents in agents.map { $0["id"]?.string == id ? $0.merging(["status": "waiting", "finished": .string(Time.iso())]) : $0 } }
        lock.lock(); liveAgents.remove(id); lock.unlock()
    }

    /// It was stopped: nothing came of it, so nothing waits.
    public static func agentStopped(_ dataRoot: String, _ id: String) throws {
        lock.lock(); liveAgents.remove(id); lock.unlock()
        try writeAgents(dataRoot) { agents in agents.filter { $0["id"]?.string != id } }
    }

    /// A workspace is being looked at: whatever was waiting there has been seen. → how many were.
    @discardableResult
    public static func seenAgents(_ dataRoot: String, _ projectId: String?, _ workspaceId: String?) throws -> Int {
        guard let pid = Ids.idOrNull(projectId), let wid = Ids.idOrNull(workspaceId) else { throw StoreError.type("seen needs a project id and a workspace id") }
        lock.lock(); defer { lock.unlock() }
        let held = cleanAgents(read(dataRoot)["agents"])
        let kept = held.filter { !($0["status"]?.string == "waiting" && $0["projectId"]?.string == pid && $0["workspaceId"]?.string == wid) }
        let seen = held.count - kept.count
        if seen > 0 { try write(dataRoot, ["agents": .array(kept)]) }
        return seen
    }
}
