import Foundation
import XCTest
import EngelbartCore
@testable import EngelbartBuild

/// A BuildHost over temporary folders: projects and workspaces in memory, their folders and project.json on disk, the
/// library in memory, the mention expansion reduced to what the tests read (a `<file>` block under the line).
final class TestHost: BuildHost, @unchecked Sendable {
    let root: String
    let dataRoot: String
    let homeDir: String
    private let lock = NSLock()
    var projectsById: [String: BuildProject] = [:]
    var workspaces: [String: [BuildWorkspace]] = [:]
    var workspaceBuilds: [String: [String]] = [:]
    var workspaceContext: [String: [String]] = [:]
    var docs: [String: String] = [:]
    var archives: [String: [(file: String, clearedAt: String, title: String, text: String)]] = [:]
    var rows: [LibraryRow] = []
    var recent: [String] = []
    var agents: [String] = []
    var slowRows: (() async -> Void)?
    let table = MemoryRunnablesTable()
    var runnables: RepoRunnablesTable { table }

    init() {
        root = NodePath.real(FileManager.default.temporaryDirectory.path) + "/engelbart-build-tests-" + UUID().uuidString.prefix(8)
        homeDir = root + "/home"
        dataRoot = root + "/data"
        try! FS.mkdirs(homeDir)
        try! FS.mkdirs(dataRoot)
        table.knownLibrary = { [weak self] id in self?.rows.contains { $0.id == id } ?? false }
    }

    func cleanup() { FS.remove(root) }

    // MARK: projects

    @discardableResult
    func createProject(_ name: String, directory: String? = nil) -> BuildProject {
        var slug = name
        var n = 2
        while projectsById.values.contains(where: { $0.slug == slug }) { slug = "\(name) \(n)"; n += 1 }
        let dir = NodePath.join(dataRoot, slug)
        try! FS.mkdirs(dir)
        let id = IDs.new()
        var meta: [String: JSONValue] = ["id": .string(id), "name": .string(name)]
        if let directory { meta["directory"] = .string(directory) }
        try! Files.writeJSON(.object(meta), to: URL(fileURLWithPath: NodePath.join(dir, "project.json")))
        let p = BuildProject(id: id, name: name, slug: slug, dir: dir, directory: directory)
        lock.lock(); projectsById[id] = p; lock.unlock()
        return p
    }

    @discardableResult
    func createWorkspace(_ projectId: String, _ name: String) -> BuildWorkspace {
        let w = BuildWorkspace(id: IDs.new(), name: name)
        lock.lock(); workspaces[projectId, default: []].append(w); lock.unlock()
        return w
    }

    func writeProjectJSON(_ project: BuildProject, _ change: [String: JSONValue]) {
        let file = URL(fileURLWithPath: NodePath.join(project.dir, "project.json"))
        var meta = Files.readJSON(file)?.object ?? [:]
        for (k, v) in change { meta[k] = v }
        try! Files.writeJSON(.object(meta), to: file)
    }

    func project(_ projectId: String) throws -> BuildProject {
        lock.lock(); defer { lock.unlock() }
        guard var p = projectsById[projectId] else { throw BuildError("Unknown project") }
        let meta = Files.readJSON(URL(fileURLWithPath: NodePath.join(p.dir, "project.json")))?.object ?? [:]
        p.defaultTarget = meta["defaultTarget"]
        p.defaultRepo = meta["defaultRepo"]?.string
        return p
    }
    func projectRecords() -> [BuildProject] { lock.lock(); defer { lock.unlock() }; return Array(projectsById.values) }
    func workspace(_ projectId: String, _ workspaceId: String?) throws -> BuildWorkspace {
        lock.lock(); defer { lock.unlock() }
        let list = workspaces[projectId] ?? []
        guard let w = workspaceId == nil ? list.first : list.first(where: { $0.id == workspaceId }) else { throw BuildError("Unknown workspace") }
        return w
    }
    func setDefaultTarget(_ projectId: String, _ target: JSONValue) throws { writeProjectJSON(try project(projectId), ["defaultTarget": target]) }
    func addWorkspaceBuild(_ projectId: String, _ workspaceId: String, _ buildId: String) throws {
        lock.lock(); if !(workspaceBuilds[workspaceId] ?? []).contains(buildId) { workspaceBuilds[workspaceId, default: []].append(buildId) }; lock.unlock()
    }
    func linkToWorkspace(_ projectId: String, _ workspaceId: String, _ ids: [String]) async throws {
        lock.lock(); for id in ids where !(workspaceContext[workspaceId] ?? []).contains(id) { workspaceContext[workspaceId, default: []].append(id) }; lock.unlock()
    }
    func recordEdit(_ projectId: String, _ workspaceId: String) { lock.lock(); recent.insert(workspaceId, at: 0); lock.unlock() }
    func agentStarted(_ record: JSONValue) { lock.lock(); agents.append("started \(record["id"]?.string ?? "")"); lock.unlock() }
    func agentFinished(_ id: String) { lock.lock(); agents.append("finished \(id)"); lock.unlock() }
    func agentStopped(_ id: String) { lock.lock(); agents.append("stopped \(id)"); lock.unlock() }
    func readWorkspaceDoc(_ projectId: String, _ workspaceId: String) async throws -> String { lock.lock(); defer { lock.unlock() }; return docs[workspaceId] ?? "" }
    func latestArchive(_ projectId: String, _ workspaceId: String) -> BuildArchive? {
        lock.lock(); defer { lock.unlock() }
        return archives[workspaceId]?.last.map { BuildArchive(file: $0.file, clearedAt: $0.clearedAt, text: $0.text) }
    }
    func clear(_ workspaceId: String, keep: (String) -> Bool = { _ in false }) {
        lock.lock()
        let text = docs[workspaceId] ?? ""
        let n = (archives[workspaceId]?.count ?? 0) + 1
        archives[workspaceId, default: []].append((file: "2026-09-25T21-03-1\(n)Z", clearedAt: "2026-09-25T21:03:1\(n).000Z", title: text, text: text))
        docs[workspaceId] = text.components(separatedBy: "\n").filter(keep).joined(separator: "\n")
        lock.unlock()
    }
    func importTask(_ projectId: String, _ workspaceId: String, text: String, buildId: String) async throws -> JSONValue {
        let title = "Imported from Task: \(BuildManager.postItTitle(text))"
        let file = "2026-09-27T20-00-0\((archives[workspaceId]?.count ?? 0))Z"
        lock.lock()
        archives[workspaceId, default: []].append((file: file, clearedAt: "2026-09-27T20:00:00.000Z", title: title, text: "Imported from Task:\n\(text.trimmingCharacters(in: .whitespacesAndNewlines))\n\nbuild> \(buildId)\n"))
        lock.unlock()
        return ["file": .string(file), "clearedAt": "2026-09-27T20:00:00.000Z", "title": .string(title)]
    }
    func createNote(_ projectId: String, name: String, workspaceId: String?, text: String) async throws -> LibraryRow {
        let p = try project(projectId)
        let file = NodePath.join(p.dir, "\(name).md")
        try FS.write(file, text)
        let row = LibraryRow(id: IDs.new(), name: name, type: "md", tags: ["note"], path: file, projectId: projectId)
        lock.lock(); rows.append(row); lock.unlock()
        if let workspaceId { try await linkToWorkspace(projectId, workspaceId, [row.id]) }
        return row
    }
    func projectPageBlock(_ projectId: String) -> String? { nil }
    func instructionsBlock() -> String? { nil }
    func memoryBlock() -> String? { nil }

    // MARK: library

    func libraryRow(_ id: String) async -> LibraryRow? { lock.lock(); defer { lock.unlock() }; return rows.first { $0.id == id } }
    func libraryRows() async -> [LibraryRow] {
        if let slow = slowRows { await slow() }
        lock.lock(); defer { lock.unlock() }; return rows
    }
    func libraryRows(forProject projectId: String) async -> [LibraryRow] {
        lock.lock(); defer { lock.unlock() }
        let linked = Set((workspaces[projectId] ?? []).flatMap { workspaceContext[$0.id] ?? [] })
        return rows.filter { $0.projectId == projectId || linked.contains($0.id) }
    }
    @discardableResult
    func insertLibraryRow(_ fields: [String: JSONValue]) async throws -> LibraryRow {
        let row = LibraryRow(id: fields["id"]?.string ?? IDs.new(), name: fields["name"]?.string ?? "", type: fields["type"]?.string ?? "folder",
                             tags: fields["tags"]?.array?.compactMap(\.string) ?? [], path: fields["path"]?.string, folderPath: fields["folder_path"]?.string,
                             url: fields["url"]?.string, projectId: fields["project_id"]?.string)
        lock.lock(); rows.append(row); lock.unlock()
        return row
    }
    func insert(_ row: LibraryRow) { lock.lock(); rows.append(row); lock.unlock() }
    func removeRow(_ id: String) { lock.lock(); rows.removeAll { $0.id == id }; lock.unlock() }
    func updateRepo(_ id: String, name: String, url: String?, folderPath: String, githubId: JSONValue?) async throws {
        lock.lock(); if let i = rows.firstIndex(where: { $0.id == id }) { rows[i].folderPath = folderPath; rows[i].type = "folder"; rows[i].url = url }; lock.unlock()
    }
    static let types = [".md": "md", ".pdf": "pdf", ".png": "image", ".jpg": "image", ".html": "html", ".csv": "csv", ".tsv": "tsv", ".json": "json", ".jsonl": "jsonl", ".svg": "svg"]
    func addLibraryItem(file: String, name: String?) async throws -> LibraryRow {
        let row = LibraryRow(id: IDs.new(), name: name ?? NodePath.basename(file), type: TestHost.types[NodePath.extname(file).lowercased()] ?? "file", path: file)
        lock.lock(); rows.append(row); lock.unlock()
        return row
    }
    func addFileCopy(bytes: Data, mime: String, name: String) async throws -> LibraryRow {
        let id = IDs.new()
        let pdf = mime == "application/pdf"
        let dir = NodePath.join(dataRoot, "assets", pdf ? "pdfs" : "images")
        try FS.mkdirs(dir)
        let file = NodePath.join(dir, "\(id).\(pdf ? "pdf" : "png")")
        try bytes.write(to: URL(fileURLWithPath: file))
        let row = LibraryRow(id: id, name: name, type: pdf ? "pdf" : "image", path: file)
        lock.lock(); rows.append(row); lock.unlock()
        return row
    }
    func libraryFileType(_ ext: String) -> String? { TestHost.types[ext] }
    var libraryFileExtensions: [String] { Array(TestHost.types.keys).sorted() }

    // MARK: context

    func expandMentions(_ text: String, projectId: String, rows all: [LibraryRow], seen: MentionSeen) async -> String {
        var out: [String] = []
        for line in text.components(separatedBy: "\n") {
            out.append(line)
            var rest = line[...]
            while let open = rest.range(of: "@["), let close = rest[open.upperBound...].range(of: "]") {
                let name = String(rest[open.upperBound..<close.lowerBound])
                rest = rest[close.upperBound...]
                guard let row = all.first(where: { $0.name == name }), !seen.contains(row.id) else { continue }
                seen.insert(row.id)
                out.append("")
                out.append("<file name=\"\(row.name)\" type=\"\(row.type)\" tags=\"\(row.tags.joined(separator: ","))\" path=\"\(row.path ?? "")\">\n\(row.path.flatMap(FS.readText) ?? "")\n</file>")
            }
        }
        return out.joined(separator: "\n")
    }
    func expandRows(_ list: [LibraryRow], projectId: String, allRows: [LibraryRow], seen: MentionSeen) async -> String {
        list.map { seen.insert($0.id); return "<file name=\"\($0.name)\" type=\"\($0.type)\" path=\"\($0.path ?? "")\">\n</file>" }.joined(separator: "\n")
    }
    func catalogJSON(projectId: String, rows all: [LibraryRow], seen: MentionSeen) -> String {
        let list = all.filter { $0.projectId == projectId }.map { "{\n  \"name\": \(JSONValue.string($0.name).text()),\n  \"mentioned\": \(seen.contains($0.id))\n }" }
        return "[\n " + list.joined(separator: ",\n ") + "\n]"
    }
}

/// git in a temporary home (no global config of the person's), as the Electron tests run it.
enum Sh {
    static func env(_ home: String) -> [String: String] {
        ["PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin", "HOME": home, "XDG_CONFIG_HOME": home + "/.config", "SHELL": "/bin/zsh"]
    }
    @discardableResult
    static func git(_ cwd: String, _ home: String, _ args: String...) -> String { git(cwd, home, args) }
    @discardableResult
    static func git(_ cwd: String, _ home: String, _ args: [String]) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["git", "-c", "user.name=Person", "-c", "user.email=p@example.com"] + args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        p.environment = env(home)
        let out = Pipe(), err = Pipe()
        p.standardOutput = out; p.standardError = err
        try! p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        _ = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static func ok(_ cwd: String, _ home: String, _ args: [String]) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["git"] + args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        p.environment = env(home)
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        try! p.run(); p.waitUntilExit()
        return p.terminationStatus == 0
    }
    static func write(_ file: String, _ text: String) {
        try! FS.mkdirs(NodePath.dirname(file))
        try! FS.write(file, text)
    }
    static func read(_ file: String) -> String { FS.readText(file) ?? "<missing>" }
}

/// Polls until `check` holds (the tests' `settled`, `turned`).
func eventually(_ timeout: TimeInterval = 15, _ check: @escaping () async -> Bool) async -> Bool {
    let until = Date().addingTimeInterval(timeout)
    while Date() < until {
        if await check() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return false
}

/// A scripted agent: each turn takes the next step (a function of the input, or a text, or an error).
final class Scripted: BuildRunner, @unchecked Sendable {
    enum Step { case text(String); case run((TurnInput) async throws -> String); case fail(Error) }
    private let lock = NSLock()
    private var steps: [Step]
    private(set) var calls: [TurnInput] = []
    init(_ steps: [Step]) { self.steps = steps }
    var count: Int { lock.lock(); defer { lock.unlock() }; return calls.count }
    func call(_ i: Int) -> TurnInput { lock.lock(); defer { lock.unlock() }; return calls[i] }
    func turn(_ input: TurnInput) async throws -> TurnOutput {
        lock.lock()
        calls.append(input)
        let n = calls.count
        let step = steps.isEmpty ? nil : steps.removeFirst()
        lock.unlock()
        guard let step else { throw TurnError("failed", "no more steps") }
        switch step {
        case .text(let t): return TurnOutput(text: t, session: input.session ?? "session-\(n)")
        case .fail(let e): throw e
        case .run(let f): return TurnOutput(text: try await f(input), session: input.session ?? "session-\(n)")
        }
    }
}

/// An agent turn that waits for Stop, as a long turn does.
func untilStopped(_ input: TurnInput, session: String? = nil) async throws -> String {
    while !input.signal.isAborted { try? await Task.sleep(nanoseconds: 10_000_000) }
    throw TurnError("stopped", "Stopped.", session: session)
}

final class Events: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [(String, JSONValue)] = []
    func add(_ c: String, _ p: JSONValue) { lock.lock(); list.append((c, p)); lock.unlock() }
    var all: [(String, JSONValue)] { lock.lock(); defer { lock.unlock() }; return list }
}
