import Foundation
import EngelbartCore

/// stat(2) at file scope (inside `Paths` the name `stat` is taken by the helper).
func posixStat(_ path: String, _ s: inout stat) -> Int32 { stat(path, &s) }

/// Onboarding's backend (onboarding.cjs, 2026-09-28): custom instructions, the folder "Create a folder for me" makes, the
/// project the last screens describe, the guided setup's Welcome workspace, and unticking a row again.
public enum Onboarding {
    public static let instructionsFile = "instructions.md"
    static let maxInstructions = 20000

    static func instructionsPath(_ dataRoot: String) -> String { Paths.join(dataRoot, instructionsFile) }

    public static func readInstructions(_ dataRoot: String) -> String {
        ((try? String(contentsOfFile: instructionsPath(dataRoot), encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Empty text removes the file: no instructions is the same as never having written any.
    @discardableResult
    public static func writeInstructions(_ dataRoot: String, _ text: String) throws -> String {
        let value = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxInstructions))
        if value.isEmpty { try? FileManager.default.removeItem(atPath: instructionsPath(dataRoot)); return "" }
        try JSONFiles.writeText(instructionsPath(dataRoot), "\(value)\n")
        return value
    }

    /// The person's custom instructions as a block of an agent's first message, or '' when there are none.
    public static func instructionsBlock(_ dataRoot: String) -> String {
        let text = readInstructions(dataRoot)
        return text.isEmpty ? "" : "<custom_instructions note=\"Written by the person about themselves and how they want to be helped. Follow them unless they conflict with your task.\">\n\(text)\n</custom_instructions>"
    }

    public struct FreeFolder: Codable, Equatable, Sendable { public var path: String; public var shown: String }

    static func shown(_ ctx: StoreContext, _ dir: String) -> String {
        dir.hasPrefix(ctx.homeDir + "/") ? "~" + dir.dropFirst(ctx.homeDir.count) : dir
    }

    /// The folder "Create a folder for me" would make for a project called `name`: ~/<slug>, else ~/<slug>-2 …
    public static func freeFolder(_ ctx: StoreContext, _ name: String) throws -> FreeFolder {
        let base = Names.slugify(name).isEmpty ? "my-project" : Names.slugify(name)
        for n in 1..<1000 {
            let dir = Paths.join(ctx.homeDir, n == 1 ? base : "\(base)-\(n)")
            if !Paths.exists(dir) { return FreeFolder(path: dir, shown: shown(ctx, dir)) }
        }
        throw StoreError("No free folder name for this project")
    }

    /// A folder the person typed: `~` is their home directory; it must exist and be a directory.
    public static func existingFolder(_ ctx: StoreContext, _ value: String) throws -> String {
        var dir = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if dir.isEmpty { throw StoreError.type("Choose a folder") }
        if dir == "~" || dir.hasPrefix("~/") { dir = Paths.join(ctx.homeDir, String(dir.dropFirst())) }
        if !dir.hasPrefix("/") { throw StoreError.type("A folder path starts with / or ~/") }
        guard let info = Paths.stat(dir) else { throw StoreError("Nothing is at \(value)") }
        guard info.isDirectory else { throw StoreError("\(value) is not a folder") }
        return Paths.resolve(dir)
    }

    public struct StartProject: Sendable {
        public var name: String
        public var description: String
        /// "new" (made now under the home directory, never an existing one) or "existing" (`directory`).
        public var folder: String
        public var directory: String
        public var context: [String]
        public var workspaceName: String
        /// A new user's onboarding (2026-10-14): the Welcome page project instead of the Welcome! note.
        public var welcomePage: Bool
        public init(name: String, description: String = "", folder: String = "new", directory: String = "", context: [String] = [],
                    workspaceName: String = "Getting started", welcomePage: Bool = false) {
            self.name = name; self.description = description; self.folder = folder; self.directory = directory
            self.context = context; self.workspaceName = workspaceName; self.welcomePage = welcomePage
        }
    }

    /// The project the Create screen describes.
    public static func startProject(_ ctx: StoreContext, _ input: StartProject) throws -> Projects.Welcomed {
        let dir: String
        if input.folder == "new" {
            dir = try freeFolder(ctx, input.name).path
            try JSONFiles.makeNewDir(dir)
        } else {
            dir = try existingFolder(ctx, input.directory)
        }
        let chosen = try contextIds(ctx, input.context)
        let project = Projects.NewProject(name: input.name, directory: dir, description: input.description)
        if input.welcomePage { return try Projects.createProjectWithWelcomePage(ctx, project, context: chosen) }
        return try Projects.createProjectWithWelcome(ctx, project, workspaceName: input.workspaceName, context: chosen)
    }

    /// Library ids a workspace can be given: rows the library has, notes left out (they belong to their own project).
    static func contextIds(_ ctx: StoreContext, _ context: [String]) throws -> [String] {
        let known = Dictionary(try ctx.libraryDb.list().map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var out: [String] = []
        for id in context where Ids.isUUID(id) && !out.contains(id) {
            if let row = known[id], !row.hasTag("note") { out.append(id) }
        }
        return out
    }

    public struct WelcomeWorkspace: Codable, Equatable, Sendable {
        public struct Project: Codable, Equatable, Sendable { public var id: String; public var name: String }
        public var project: Project
        public var workspaceId: String
        public var importedNotes: Int?
        public var gettingStarted: GettingStartedState?
    }

    /// The guided setup started inside a project (2026-10-10): no project is made; this one gets a "Welcome" workspace
    /// (unique: a second run's is "Welcome 2") holding `context`.
    public static func addWelcomeWorkspace(_ ctx: StoreContext, _ projectId: String, context: [String] = []) throws -> WelcomeWorkspace {
        let project = try Projects.find(ctx, projectId)
        let chosen = try contextIds(ctx, context)
        let workspace = try Workspaces.create(ctx, project.id, name: "Welcome")
        if !chosen.isEmpty { try Workspaces.setContext(ctx, project.id, workspace.id, chosen) }
        return WelcomeWorkspace(project: .init(id: project.id, name: project.name), workspaceId: workspace.id)
    }

    /// A row added during onboarding and unticked again goes, only when it is not a note and no project holds it.
    /// `release` runs first (a repository's sandbox stopped). → whether it went
    @discardableResult
    public static func discardItem(_ ctx: StoreContext, _ id: String, release: (() async throws -> Void)? = nil) async throws -> Bool {
        guard Ids.isUUID(id) else { throw StoreError.type("library id is invalid") }
        guard let row = try ctx.libraryDb.get(id), !row.hasTag("note"), row.projectId == nil else { return false }
        if !(try Library.projectsForLibraryItem(ctx, id)).isEmpty { return false }
        if let release { try await release() }
        return try ctx.libraryDb.remove(id)
    }
}

/// The Welcome walkthrough's state (getting-started.cjs, 2026-10-09).
public struct GettingStartedState: Codable, Equatable, Sendable {
    public var workspaceId: String?
    public var ticked: [Int]
    public var hidden: Bool
    public var steps: Int
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(workspaceId, forKey: .workspaceId); try c.encode(ticked, forKey: .ticked); try c.encode(hidden, forKey: .hidden); try c.encode(steps, forKey: .steps)
    }
    enum CodingKeys: String, CodingKey { case workspaceId, ticked, hidden, steps }
}

/// The Welcome walkthrough (getting-started.cjs): `<project>/.context/getting-started.json` { workspaceId, ticked, hidden },
/// and the guided setup's one-time offer, `<dataRoot>/.guided-setup.json`.
public enum GettingStarted {
    public static let steps = 3
    static let file = "getting-started.json"

    static func fileOf(_ ctx: StoreContext, _ projectId: String) throws -> String {
        Paths.join(try Projects.find(ctx, projectId).dir, ".context", file)
    }

    static func cleanTicks(_ values: [Int]) -> [Int] { Array(Set(values.filter { $0 >= 1 && $0 <= steps })).sorted() }
    static func cleanTicks(_ value: JSONValue?) -> [Int] {
        cleanTicks((value?.array ?? []).compactMap { $0.double.flatMap { $0.rounded() == $0 ? Int($0) : nil } })
    }

    static func publicState(_ value: JSONValue) -> GettingStartedState {
        GettingStartedState(workspaceId: value["workspaceId"]?.string.flatMap { $0.isEmpty ? nil : $0 }, ticked: cleanTicks(value["ticked"]),
                            hidden: value["hidden"]?.bool == true, steps: steps)
    }

    /// The walkthrough's state for a project, or nil: none.
    public static func read(_ ctx: StoreContext, _ projectId: String) -> GettingStartedState? {
        guard let path = try? fileOf(ctx, projectId), let value = JSONFiles.read(path), value.isPlainObject else { return nil }
        return publicState(value)
    }

    @discardableResult
    static func write(_ ctx: StoreContext, _ projectId: String, _ state: GettingStartedState) throws -> GettingStartedState {
        let path = try fileOf(ctx, projectId)
        try JSONFiles.makeDir(Paths.dirname(path))
        let clean = GettingStartedState(workspaceId: state.workspaceId, ticked: cleanTicks(state.ticked), hidden: state.hidden, steps: steps)
        try JSONFiles.writeText(path, JSONValue.object(["workspaceId": clean.workspaceId.map { .string($0) } ?? .null, "ticked": .array(clean.ticked.map { .number(Double($0)) }), "hidden": .bool(clean.hidden)]).text(pretty: true) + "\n")
        return clean
    }

    /// Onboarding made the project, or added a Welcome workspace to it: its walkthrough, nothing ticked.
    @discardableResult
    public static func start(_ ctx: StoreContext, _ projectId: String, workspaceId: String) throws -> GettingStartedState {
        try write(ctx, projectId, GettingStartedState(workspaceId: workspaceId, ticked: [], hidden: false, steps: steps))
    }

    /// Ticks added, unticks taken off, `hidden`; once hidden it stays hidden.
    @discardableResult
    public static func set(_ ctx: StoreContext, _ projectId: String, tick: [Int] = [], untick: [Int] = [], hidden: Bool? = nil) throws -> GettingStartedState {
        guard let now = read(ctx, projectId) else { throw StoreError("This project has no walkthrough") }
        let off = Set(cleanTicks(untick))
        let ticked = cleanTicks(now.ticked + cleanTicks(tick)).filter { !off.contains($0) }
        return try write(ctx, projectId, GettingStartedState(workspaceId: now.workspaceId, ticked: ticked, hidden: now.hidden || hidden == true, steps: steps))
    }

    public static let offerFile = ".guided-setup.json"
    static let offerHow: Set<String> = ["shown", "started", "dismissed", "onboarded"]

    /// Whether the guided setup's offer is still to be shown in this data root.
    public static func guidedOfferDue(_ dataRoot: String) -> Bool {
        JSONFiles.read(Paths.join(dataRoot, offerFile))?["seen"]?.bool != true
    }

    /// The offer shown or answered: never shown again here. → { seen, how, at }
    @discardableResult
    public static func markGuidedOffer(_ dataRoot: String, _ how: String, now: Date = Date()) throws -> JSONValue {
        let value: JSONValue = ["seen": true, "how": .string(offerHow.contains(how) ? how : "dismissed"), "at": .string(Time.iso(now))]
        try JSONFiles.makeDir(dataRoot)
        try JSONFiles.writeText(Paths.join(dataRoot, offerFile), value.text(pretty: true) + "\n")
        return value
    }

    /// Connect your library's one-time popup (ipc.cjs connect-offer): `<dataRoot>/.connect/offer.json`.
    public static func connectOfferDue(_ dataRoot: String) -> Bool {
        guard let value = JSONFiles.read(Paths.join(dataRoot, ".connect", "offer.json")) else { return true }
        return value["seen"]?.bool != true
    }

    public static func markConnectOffer(_ dataRoot: String, _ how: String) throws {
        let dir = Paths.join(dataRoot, ".connect")
        try JSONFiles.makeDir(dir)
        try JSONFiles.writeText(Paths.join(dir, "offer.json"), JSONValue.object(["seen": true, "how": .string(how == "started" ? "started" : "dismissed"), "at": .string(Time.iso())]).text())
    }
}
