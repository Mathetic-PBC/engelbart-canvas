import Foundation
import EngelbartCore

/// Where a Build works (2026-09-29): the repository chosen in the Build panel, else the project's default repo, which
/// project.json keeps as a target (defaultTarget): the code directory ({ kind: 'project' }) or a library row
/// ({ kind: 'library', id }). A project with none gets one Engelbart makes: a folder in the code directory named after the
/// project, made with a history of its own when the first Build starts there, then kept as its library row, so a rename
/// never moves it. A folder of that name that is the person's own is never taken: the next free name is. Nothing is ever
/// git-initialised in a folder the person chose. The picker lists the default repo and the git rows this project holds.
extension BuildManager {
    /// What the Build panel names: the default repo, the project folder, or a library row.
    public static func targetOf(_ input: JSONValue?) -> JSONValue {
        let value = input?.object ?? [:]
        if value["kind"]?.string == "project" { return ["kind": "project"] }
        if value["kind"]?.string == "library", let id = value["id"]?.string, isUUID(id) { return ["kind": "library", "id": .string(id)] }
        return ["kind": "default"]
    }

    static func folderThere(_ dir: String?) -> Bool { dir.map(FS.isDirectory) ?? false }
    static func ownRepository(_ dir: String) -> Bool { FS.isDirectory(NodePath.join(dir, ".git")) }
    static func sameFolder(_ a: String?, _ b: String?) -> Bool {
        guard let a, let b, !a.isEmpty, !b.isEmpty else { return false }
        return NodePath.real(a) == NodePath.real(b)
    }
    static func hasGit(_ dir: String) -> Bool { FS.exists(NodePath.join(dir, ".git")) }

    /// A default repo Engelbart makes, for a project that has none: the first of <name>, <name>-2 … that is missing,
    /// empty, or a repository of its own; never a folder of the person's with no history of its own.
    static func newFolder(_ project: BuildProject) throws -> String {
        let slug = Repository.slugify(project.name)
        let base = slug.isEmpty ? "repo" : slug
        for n in 1..<100 {
            let at = NodePath.join(project.directory ?? "", n == 1 ? base : "\(base)-\(n)")
            if !FS.exists(at) || ownRepository(at) || FS.emptyFolder(at) { return at }
        }
        throw BuildError("No free folder for the default repository")
    }

    // What git says when GitHub turns a clone's credentials away (or hides a private repository behind "not found").
    static let refused = "authentication failed|could not read (username|password)|repository not found|returned error: 40[134]|access denied|not found"
    static func isRefused(_ message: String) -> Bool { message.range(of: refused, options: [.regularExpression, .caseInsensitive]) != nil }
    static func cloneError(_ name: String, _ error: Error) -> BuildError {
        let message = error.text
        return BuildError(isRefused(message)
            ? "\(name) could not be cloned: GitHub refused (\(message)). If it is private, Engelbart's GitHub App must be installed where it lives, with access to it."
            : "\(name) could not be cloned: \(message)")
    }

    /// Where a GitHub repository is cloned for a Build: repos/<name> in the project folder, else repos/<name>-2 …
    static func cloneFolder(_ project: BuildProject, _ url: String) throws -> String {
        let parent = NodePath.join(project.directory ?? "", clones)
        let raw = Repository.github(url)?.name.replacingOccurrences(of: #"\.git$"#, with: "", options: [.regularExpression, .caseInsensitive]) ?? ""
        let name = raw.isEmpty ? "repository" : raw
        for n in 1..<100 {
            let at = NodePath.join(parent, n == 1 ? name : "\(name)-\(n)")
            if !FS.exists(at) { return at }
        }
        throw BuildError("No free folder for the clone")
    }

    struct Located { var target: JSONValue; var folder: String?; var url: String?; var fresh: Bool }

    /// Where a target is; `folder` is nil for a library repository not on this Mac.
    func locate(_ project: BuildProject, _ input: JSONValue?) async throws -> Located? {
        let target = BuildManager.targetOf(input)
        switch target["kind"]?.string {
        case "default":
            guard let mine = try await defaultFolder(project.id) else { return nil }
            return Located(target: ["kind": "default", "name": .string(mine.name)], folder: mine.folder, url: nil, fresh: mine.fresh)
        case "project":
            return Located(target: ["kind": "project", "name": .string(NodePath.basename(project.directory ?? ""))], folder: project.directory, url: nil, fresh: false)
        default:
            let id = target["id"]?.string ?? ""
            guard let row = await host.libraryRow(id), row.isRepo else { throw BuildError("That repository is not in the library.") }
            let github = Repository.github(row.url)
            return Located(target: ["kind": "library", "id": .string(id), "name": .string(row.name)],
                           folder: BuildManager.folderThere(row.folderPath) ? row.folderPath : nil, url: github?.url, fresh: false)
        }
    }

    /// The repositories a Build can work in, for the panel's picker: the default repo first, then the code directory when
    /// it is a repository, then the git rows this project holds; a folder is listed once.
    public func targets(_ projectId: String) async throws -> [JSONValue] {
        let project = try projectOf(projectId)
        let mine = try await defaultFolder(projectId)
        var list: [JSONValue] = mine.map { [["kind": "default", "name": .string($0.name), "folder": .string($0.folder), "place": "default"]] } ?? []
        guard let directory = project.directory else { return list }
        var seen = Set(mine.map { [NodePath.real($0.folder)] } ?? [])
        if !seen.contains(NodePath.real(directory)) && Repository.inspect(directory).repository {
            list.append(["kind": "project", "name": .string(NodePath.basename(directory)), "folder": .string(directory), "place": "project"])
            seen.insert(NodePath.real(directory))
        }
        for row in await host.libraryRows(forProject: projectId) where row.isRepo {
            let folder = BuildManager.folderThere(row.folderPath) ? row.folderPath : nil
            let github = Repository.github(row.url)
            if (folder == nil && github == nil) || (folder.map { seen.contains(NodePath.real($0)) } ?? false) { continue }
            if let folder { seen.insert(NodePath.real(folder)) }
            list.append(["kind": "library", "id": .string(row.id), "name": .string(row.name), "folder": folder.map(JSONValue.string) ?? .null,
                         "url": github.map { .string($0.url) } ?? .null, "place": folder != nil ? "local" : "github"])
        }
        return list
    }

    static func problems(_ list: [RepositoryReport.Problem]) -> JSONValue { .array(list.map { ["code": .string($0.code), "message": .string($0.message)] }) }

    /// Whether the chosen repository (the default repo when none is) can take a Build, and what the panel should say.
    public func preflight(_ projectId: String, _ input: JSONValue?) async throws -> JSONValue {
        let project = try projectOf(projectId)
        let noFolder: JSONValue = ["ok": false, "problems": [["code": "no-directory", "message": "This project has no code folder."]], "dirty": 0, "canInit": false]
        // The default repo can be a library row somewhere else; anything else needs the code directory.
        if project.directory == nil && BuildManager.targetOf(input)["kind"]?.string != "default" { return noFolder }
        guard let at = try await locate(project, input) else { return noFolder }
        var base: [String: JSONValue] = ["target": at.target, "directory": at.folder.map(JSONValue.string) ?? .null]
        func with(_ extra: [String: JSONValue]) -> JSONValue { .object(base.merging(extra) { _, b in b }) }
        if !config.gitReady() {
            return with(["ok": false, "problems": [["code": "no-git", "message": "Git is not set up yet (Engelbart ▸ Set Up Tools…)."]], "dirty": 0, "canInit": false])
        }
        let name = at.target["name"]?.string ?? ""
        guard let folder = at.folder else {
            let problem = at.url != nil ? "\(name) is not on this Mac yet." : "\(name)'s folder is gone."
            var out: [String: JSONValue] = ["ok": false, "problems": [["code": "not-here", "message": .string(problem)]], "dirty": 0, "canInit": false, "canClone": .bool(at.url != nil), "cloneTo": .null]
            if let url = at.url { out["cloneTo"] = .string(NodePath.relative(project.directory ?? "", try BuildManager.cloneFolder(project, url))) }
            return with(out)
        }
        // A default repo Engelbart makes: missing, or without a history of its own, it is made when the Build starts.
        let report: RepositoryReport? = at.fresh && !BuildManager.ownRepository(folder) ? nil : Repository.inspect(folder)
        if at.fresh && (report == nil || (report!.problems.count == 1 && report!.problems[0].code == "no-commits")) {
            return with(["ok": true, "create": true, "dirty": 0, "problems": [], "canInit": false])
        }
        let r = report!
        let blocking = r.problems.filter { $0.code != "not-a-repository" && $0.code != "no-commits" }
        let canInit = !r.problems.isEmpty && blocking.isEmpty
        // A folder with no history of its own is not the person's to fix (2026-09-29): the Build gives it one when it
        // starts, and the panel says nothing about it. Not the default repo: that is never git-initialised.
        base["top"] = r.top.map(JSONValue.string) ?? .null
        base["branch"] = r.branch.map(JSONValue.string) ?? .null
        if canInit && at.target["kind"]?.string != "default" {
            return with(["ok": true, "init": true, "dirty": 0, "problems": [], "canInit": .bool(canInit)])
        }
        var dirty = 0
        if r.repository && r.commits, let top = r.top { dirty = (try? await git.dirtyPaths(top).count) ?? 0 }
        return with(["ok": .bool(r.problems.isEmpty), "dirty": .number(Double(dirty)), "problems": BuildManager.problems(r.problems), "canInit": .bool(canInit)])
    }

    /// git init and a first commit in a folder that had none (B17's "Start history"; since 2026-09-29 start does it unasked).
    public func initRepository(_ projectId: String, _ input: JSONValue?) async throws -> JSONValue {
        let pre = try await preflight(projectId, input)
        guard pre["canInit"]?.bool == true, let dir = pre["directory"]?.string else {
            throw BuildError(pre["problems"]?[0]?["message"]?.string ?? "This folder already has a history.")
        }
        let git = self.git
        _ = try await serial(dir) { try await git.initRepository(dir) }
        return try await preflight(projectId, input)
    }

    /// The default repo, made: its folder, and a history of its own with a first commit (never a parent repository's).
    func makeDefault(_ folder: String) async throws {
        let git = self.git
        _ = try await serial(folder) {
            if BuildManager.ownRepository(folder) && Repository.inspect(folder).commits { return }
            try FS.mkdirs(folder)
            try await git.initRepository(folder, own: true)
        }
    }

    /// The default repo's library row: a folder tagged git, made in this project; one row per folder, never a second.
    func recordDefault(_ projectId: String, _ folder: String, name: String? = nil) async throws -> LibraryRow {
        let at = NodePath.real(folder)
        let host = self.host, changed = config.libraryChanged
        return try await serial("library:\(at)") {
            if let held = await BuildManager.rowAt(host, folder) { return held }
            let row = try await host.insertLibraryRow(["id": .string(IDs.new()), "name": .string(name ?? NodePath.basename(folder)), "type": "folder",
                                                       "tags": ["git"], "folder_path": .string(folder), "project_id": .string(projectId),
                                                       "source": "engelbart", "category": "repo"])
            changed()
            return row
        }
    }

    /// The library row of a folder (a git row first; `preferred`, when it is that folder's) → the row, or nil.
    static func rowAt(_ host: BuildHost, _ folder: String, preferred: String? = nil) async -> LibraryRow? {
        if let preferred, isUUID(preferred), let row = await host.libraryRow(preferred), sameFolder(row.folderPath, folder) { return row }
        let rows = await host.libraryRows().filter { $0.folderPath != nil && sameFolder($0.folderPath, folder) }
        return rows.first { $0.isRepo } ?? rows.first
    }

    /// project.json from before defaultTarget, converted once (nothing is moved or deleted):
    ///   a. defaultRepoId → repositories[id].location, when that folder is a repository of its own
    ///   b. else defaultRepo (a folder name in the code directory, made by a Build) → its library row, made if missing
    ///   c. else nothing: the first Build makes one
    func migrateDefault(_ projectId: String) async throws -> BuildProject {
        let first = try projectOf(projectId)
        if first.defaultTarget != nil { return first }
        let host = self.host
        return try await serial("default:\(first.dir)") { [self] in
            let project = try host.project(projectId)
            if project.defaultTarget != nil { return project }
            let meta = Files.readJSON(URL(fileURLWithPath: NodePath.join(project.dir, "project.json")))?.object ?? [:]
            let made = project.defaultRepo.flatMap { r in project.directory.map { NodePath.join($0, r) } }
            let registry = meta["repositories"]?.object ?? [:]
            let registered = meta["defaultRepoId"]?.string.flatMap { registry[$0]?.object }
            var target: JSONValue?
            var note: String?
            if let registered, let location = registered["location"]?.string, !location.isEmpty, !registered.truthy("archived") {
                let at = NodePath.resolve(project.dir, location) // an absolute location stays as it is
                if BuildManager.folderThere(at) && BuildManager.hasGit(at) {
                    if let directory = project.directory, BuildManager.sameFolder(at, directory) { target = ["kind": "project"] }
                    else {
                        let given = registered["name"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
                        let row: LibraryRow
                        if let held = await BuildManager.rowAt(host, at, preferred: registered["libraryId"]?.string) { row = held }
                        else { row = try await self.recordDefault(projectId, at, name: given.flatMap { $0.isEmpty ? nil : String($0.prefix(200)) }) }
                        target = ["kind": "library", "id": .string(row.id)]
                    }
                    if let made, BuildManager.folderThere(made), !BuildManager.sameFolder(made, at) {
                        note = "The default repo for Builds is now \(at) (project.json → defaultRepoId). \(made) was made as the default repo before and is no longer used by Builds; nothing was moved or deleted."
                    }
                }
            }
            if target == nil, let made, BuildManager.folderThere(made), BuildManager.hasGit(made) {
                target = ["kind": "library", "id": .string(try await self.recordDefault(projectId, made).id)]
            }
            guard let target else { return project }
            try host.setDefaultTarget(projectId, target)
            if let note { await self.unused(project, note) }
            return try host.project(projectId)
        }
    }

    /// One line for the person in the project's Build history (builds/history.log), and in the log.
    func unused(_ project: BuildProject, _ line: String) {
        let text = "\(Time.iso(now())) \(line)"
        let dir = NodePath.join(project.dir, "builds"), file = NodePath.join(dir, "history.log")
        try? FS.mkdirs(dir)
        if let handle = FileHandle(forWritingAtPath: file) { handle.seekToEndOfFile(); handle.write(Data("\(text)\n".utf8)); try? handle.close() }
        else { try? FS.write(file, "\(text)\n") }
        NSLog("Engelbart: %@: %@", project.name, line)
    }

    struct DefaultFolder { var folder: String; var name: String; var fresh: Bool; var keep: JSONValue? }

    /// The default repo now; nil (no code directory and no default elsewhere). `keep`: what start() stores when it works
    /// there ("made": its row).
    func defaultFolder(_ projectId: String) async throws -> DefaultFolder? {
        let project = try await migrateDefault(projectId)
        let stored = project.defaultTarget
        if stored?["kind"]?.string == "project", let directory = project.directory {
            return DefaultFolder(folder: directory, name: NodePath.basename(directory), fresh: false, keep: nil)
        }
        if stored?["kind"]?.string == "library", let id = stored?["id"]?.string, let row = await host.libraryRow(id),
           let folder = row.folderPath, BuildManager.folderThere(folder) {
            return DefaultFolder(folder: folder, name: row.name.isEmpty ? NodePath.basename(folder) : row.name, fresh: false, keep: nil)
        }
        guard let directory = project.directory else { return nil }
        if stored != nil {
            let code = Repository.inspect(directory)
            if code.repository && code.commits { return DefaultFolder(folder: directory, name: NodePath.basename(directory), fresh: false, keep: ["kind": "project"]) }
        }
        let folder = try BuildManager.newFolder(project)
        return DefaultFolder(folder: folder, name: NodePath.basename(folder), fresh: true, keep: "made")
    }

    /// After a Build starts in the default repo: a default made or fallen back to is kept in project.json.
    func keepDefault(_ projectId: String, _ folder: String) async throws {
        guard let mine = try await defaultFolder(projectId), let keep = mine.keep, BuildManager.sameFolder(mine.folder, folder) else { return }
        let project = try projectOf(projectId)
        let target: JSONValue = keep == "made" ? ["kind": "library", "id": .string(try await recordDefault(projectId, folder).id)] : keep
        let host = self.host
        _ = try await serial("default:\(project.dir)") { try host.setDefaultTarget(projectId, target) }
    }

    /// The project's default repo, changed by the person (the picker's Make default): the code directory or a library
    /// row that is on this Mac and can take a Build now. Only project.json changes. → the picker's list
    public func setDefault(_ projectId: String, _ input: JSONValue?) async throws -> [JSONValue] {
        let kind = input?["kind"]?.string
        let target: JSONValue? = kind == "project" || kind == "library" ? BuildManager.targetOf(input) : nil
        guard let target, target["kind"]?.string != "default" else { throw BuildError("Choose the code directory or a repository from the library.") }
        let pre = try await preflight(projectId, target)
        if pre["ok"]?.bool != true {
            throw BuildError(pre["problems"]?[0]?["message"]?.string ?? "\(pre["target"]?["name"]?.string ?? "It") cannot take a Build.")
        }
        // A folder a Build would give a history first is not one yet: the default is never git-initialised.
        if pre["init"]?.bool == true { throw BuildError(Repository.inspect(pre["directory"]?.string ?? "").problems.first?.message ?? "This folder has no history yet.") }
        let project = try await migrateDefault(projectId)
        let host = self.host
        _ = try await serial("default:\(project.dir)") { try host.setDefaultTarget(projectId, target) }
        return try await targets(projectId)
    }

    /// A project whose folder Engelbart made (onboarding's "Create a folder for me"): its default repo, made now, and kept
    /// as the project's default. Nothing while Git is not ready.
    public func prepareDefault(_ projectId: String) async throws -> String? {
        let project = try projectOf(projectId)
        guard project.directory != nil, config.gitReady() else { return nil }
        guard let mine = try await defaultFolder(projectId) else { return nil }
        if mine.fresh { try await makeDefault(mine.folder) }
        try await keepDefault(projectId, mine.folder)
        return mine.folder
    }

    /// A GitHub repository from the library, cloned into repos/<name> in the project folder; its row keeps the clone.
    public func cloneRepository(_ projectId: String, _ input: JSONValue?) async throws -> JSONValue {
        let project = try projectOf(projectId)
        let pre = try await preflight(projectId, input)
        guard pre["canClone"]?.bool == true else {
            throw BuildError(pre["ok"]?.bool == true ? "\(pre["target"]?["name"]?.string ?? "") is already on this Mac." : pre["problems"]?[0]?["message"]?.string ?? "It cannot be cloned.")
        }
        let name = pre["target"]?["name"]?.string ?? ""
        let id = pre["target"]?["id"]?.string ?? ""
        let git = self.git, host = self.host, token = config.githubToken, changed = config.libraryChanged
        _ = try await serial("clone:\(id)") { [self] in
            guard let at = try await self.locate(project, input), at.folder == nil, let url = at.url else { return } // cloned meanwhile
            let into = try BuildManager.cloneFolder(project, url)
            // The GitHub sign-in first; if GitHub refuses it, the person's own Git credentials.
            let signIn = await token()
            do { try await git.clone(url, into, token: signIn) }
            catch let first {
                guard signIn != nil, BuildManager.isRefused(first.text) else { throw BuildManager.cloneError(name, first) }
                do { try await git.clone(url, into) } catch { throw BuildManager.cloneError(name, first) }
            }
            if let row = await host.libraryRow(id) {
                try await host.updateRepo(row.id, name: row.name, url: row.url, folderPath: into, githubId: row.githubId)
                changed()
            }
        }
        return try await preflight(projectId, input)
    }
}
