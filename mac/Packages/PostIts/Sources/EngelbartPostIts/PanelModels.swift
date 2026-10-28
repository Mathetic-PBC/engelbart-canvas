import Foundation
import SwiftUI
import EngelbartCore
import EngelbartBuild

/// The Build popup's state (post-its/PostItBuild.jsx): the grid's pick, each model's last effort, the default repo's
/// preflight, the library rows picked as Context, and the send.
@MainActor
public final class PostItBuildModel: ObservableObject {
    public let projectId: String
    public let postItId: String
    public let text: String
    let build: PostItsBuild
    let memory: PickMemory
    @Published public var models: BuildChoices?
    @Published public var choice: ModelChoice?
    @Published public var efforts: [String: String]
    @Published public var pre: JSONValue?
    @Published public var picked: [PickRow] = []
    @Published public var ctxOpen = false
    @Published public var busy = false
    @Published public var error = ""
    var onStarted: (JSONValue) -> Void = { _ in }
    var onLibraryChanged: () -> Void = {}
    /// A post-it's Build always works in the default repo: no picker (2026-09-29).
    static let target: JSONValue = ["kind": "default"]

    init(projectId: String, postItId: String, text: String, build: PostItsBuild, memory: PickMemory) {
        self.projectId = projectId; self.postItId = postItId; self.text = text; self.build = build; self.memory = memory
        efforts = memory.efforts
    }

    func load() async {
        do {
            let json = try await build.buildModels("quick")
            if let c = BuildChoices(json: json) {
                models = c
                choice = ModelPick.startingChoice(c, kept: memory) { [build] pick in
                    Task { try? await build.rememberModelChoice("quick", provider: pick.provider, model: pick.model, effort: pick.effort) }
                }
                efforts = memory.efforts
            }
        } catch { self.error = errorText(error) }
        do { pre = try await build.buildPreflight(projectId, Self.target) } catch { self.error = errorText(error) }
    }

    /// A pick: kept as where the next post-it's Build starts (main), and the effort this model was given (here).
    func choose(_ next: ModelChoice) {
        choice = next
        efforts[next.model] = next.effort
        memory.write(["efforts": .object(efforts.mapValues(JSONValue.string))])
        Task { [build] in try? await build.rememberModelChoice("quick", provider: next.provider, model: next.model, effort: next.effort) }
    }

    public var ready: Bool {
        choice != nil && pre?["ok"]?.bool == true && !busy && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The red line: an error, else what keeps the repository from taking a Build.
    public var problem: String {
        if !error.isEmpty { return error }
        if let pre, pre["ok"]?.bool != true { return pre["problems"]?[0]?["message"]?.string ?? "" }
        return ""
    }

    /// "Opus High · in engelbart".
    public var footLabel: String {
        let label = ModelPick.choiceLabel(models, choice)
        if let name = pre?["target"]?["name"]?.string { return "\(label) · in \(name)" }
        return label
    }

    public func toggle(_ row: PickRow) {
        if picked.contains(where: { $0.id == row.id }) { picked.removeAll { $0.id == row.id } } else { picked.append(row) }
    }

    func added(_ rows: [PickRow]) {
        for row in rows where !picked.contains(where: { $0.id == row.id }) { picked.append(row) }
        onLibraryChanged()
    }

    public func send() async {
        guard ready, let choice else { return }
        busy = true
        error = ""
        do {
            let task = try await build.buildStart(projectId, [
                "kind": "quick", "postItId": .string(postItId), "text": .string(text),
                "provider": .string(choice.provider), "model": .string(choice.model), "effort": .string(choice.effort),
                "attach": .array(picked.map { .string($0.id) }), "target": Self.target,
            ])
            onStarted(task)
        } catch {
            self.error = errorText(error)
            busy = false
        }
    }
}

/// The Build popup's Context popout (PostItBuild.jsx ContextPopout): a search over the library whose rows are picked and
/// unpicked, then a link or path, files from disk, or a repository from GitHub, added to the library and picked at once.
@MainActor
public final class ContextModel: ObservableObject {
    let build: PostItBuildModel
    let context: PostItsContext
    @Published public var query = ""
    /// 'menu' | 'github'
    @Published public var view = "menu"
    @Published public var value = ""
    @Published public var busy = false
    @Published public var error = ""
    @Published var bodies: [String: String]?
    @Published var focusTick = 0

    init(build: PostItBuildModel, context: PostItsContext) { self.build = build; self.context = context }

    /// What things say, matched too (MATH-29): asked each time the popout opens.
    func open() async {
        if let read = context.bodies { bodies = await read() }
    }

    /// Picked rows stay listed while nothing is typed, even when they are not among the recent ones.
    public var rows: [PickRow] {
        let found = PostItLists.attachRows(query: query, library: context.library(), bodies: bodies)
        if !query.trimmingCharacters(in: .whitespaces).isEmpty { return found }
        return build.picked.filter { p in !found.contains { $0.id == p.id } } + found
    }

    func run(_ work: @escaping () async throws -> Void) async {
        busy = true; error = ""
        do { try await work() } catch { self.error = errorText(error) }
        busy = false
    }

    public func add() async {
        let input = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty, !busy, let addItem = context.addLibraryItem else { return }
        await run { [self] in build.added([try await addItem(input)]); value = "" }
    }

    public func disk() async {
        guard let pick = context.pickPaths, let addItem = context.addLibraryItem else { return }
        await run { [self] in
            var added: [PickRow] = [], problems: [String] = []
            for file in await pick() {
                do { added.append(try await addItem(file)) } catch { problems.append(errorText(error)) }
            }
            if !added.isEmpty { build.added(added) }
            if !problems.isEmpty { throw GeometryError(problems.joined(separator: " · ")) }
        }
    }

    func github(url: String, row: PickRow?) async {
        await run { [self] in
            if let row { build.added([row]) }
            else if let addItem = context.addLibraryItem { build.added([try await addItem(url)]) }
            view = "menu"
        }
    }
}

/// A quick task's card (post-its/PostItTask.jsx): its state, Stop while it works; once it stopped short, the project to
/// continue it in, the model, Discard and the send.
@MainActor
public final class PostItTaskModel: ObservableObject {
    public let projectId: String
    public let taskId: String
    public let postItId: String?
    let build: PostItsBuild
    public let workspaces: [WorkspaceEntry]
    @Published public var task: JSONValue
    @Published public var progress: JSONValue?
    @Published public var models: BuildChoices?
    @Published public var choice: ModelChoice
    @Published public var workspaceId: String?
    @Published public var modelOpen = false
    @Published public var confirm = false { didSet { if confirm { armConfirm() } } }
    @Published public var busy = false
    @Published public var error = ""
    @Published public var wsOpen = false
    @Published public var wsQuery = ""
    var onAction: (String) -> Void = { _ in }
    var onPromoted: (JSONValue) -> Void = { _ in }
    var onClose: () -> Void = {}
    var confirmTimer: Timer?

    init(projectId: String, task: JSONValue, progress: JSONValue?, postItId: String?, build: PostItsBuild, workspaces: [WorkspaceEntry], hereId: String?) {
        self.projectId = projectId; self.task = task; self.progress = progress; self.postItId = postItId; self.build = build; self.workspaces = workspaces
        taskId = task["id"]?.string ?? ""
        choice = ModelChoice(provider: task["provider"]?.string ?? "", model: task["model"]?.string ?? "", effort: task["effort"]?.string ?? "")
        workspaceId = workspaces.contains { $0.id == hereId } ? hereId : workspaces.first?.id
    }

    func load() async {
        if let json = try? await build.buildModels("build"), let c = BuildChoices(json: json) { models = c }
    }

    public var status: String { task["status"]?.string ?? "" }
    public var working: Bool { QuickTaskText.working(status) }
    public var word: String { QuickTaskText.word(status) }
    public var activity: String { QuickTaskText.activity(status: status, progress: progress?["activity"]?.string) }
    public var message: String { QuickTaskText.message(status: status, error: task["error"]?.string) }
    public var target: WorkspaceEntry? { workspaces.first { $0.id == workspaceId } }
    public var ready: Bool { target != nil && !busy }
    public var chipLabel: String { let l = ModelPick.choiceLabel(models, choice); return l.isEmpty ? (task["modelName"]?.string ?? "") : l }

    /// The project field's rows: every workspace, or (typed) those whose names hold the words.
    public var wsRows: [WorkspaceEntry] {
        wsQuery.trimmingCharacters(in: .whitespaces).isEmpty ? workspaces : PostItLists.findWorkspaces(workspaces, wsQuery)
    }

    /// Discard asks a second click within 4 s.
    func armConfirm() {
        confirmTimer?.invalidate()
        confirmTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.confirm = false } }
    }

    public func discard() {
        if confirm { confirm = false; onAction("discard"); onClose() } else { confirm = true }
    }

    public func pick(_ id: String) { workspaceId = id; wsOpen = false; wsQuery = "" }

    public func promote() async {
        guard ready, let workspaceId else { return }
        busy = true
        error = ""
        do {
            let moved = try await build.buildPromote(projectId, taskId, workspaceId, choice: choice.json)
            onPromoted(moved)
        } catch {
            self.error = errorText(error)
            busy = false
        }
    }
}

/// The trash panel's state (post-its/TrashPanel.jsx): the post-its in the trash of the project in front (read again when
/// the count changes), and the projects deleted in the switcher.
@MainActor
public final class TrashPanelModel: ObservableObject {
    public struct Project: Equatable, Identifiable, Sendable {
        public var id: String, name: String, nested: Int, expires: Date
        public init(id: String, name: String, nested: Int, expires: Date) { self.id = id; self.name = name; self.nested = nested; self.expires = expires }
    }
    weak var controller: PostItsController?
    @Published public var rows: [TrashedPostIt]?
    @Published public var projects: [Project]
    @Published public var problem = ""
    let restoreProject: ((String) async throws -> Void)?
    var watch: Any?
    let now: () -> Date

    /// `controller` nil: the project is not in front (no stickies listed).
    public init(controller: PostItsController?, projects: [Project] = [], restoreProject: ((String) async throws -> Void)? = nil, now: @escaping () -> Date = { Date() }) {
        self.controller = controller; self.projects = projects; self.restoreProject = restoreProject; self.now = now
        watch = controller?.$trashCount.removeDuplicates().sink { [weak self] _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.reload() } }
        }
    }

    func reload() { Task { @MainActor [weak self] in await self?.load() } }

    public func load() async {
        guard let controller else { rows = nil; return }
        rows = await controller.trashed()
    }

    public func restore(_ id: String) async {
        do { _ = try await controller?.restore(id); problem = ""; await load() } catch { problem = errorText(error) }
    }

    public func bringBack(_ id: String) async {
        do { try await restoreProject?(id); problem = ""; projects.removeAll { $0.id == id } } catch { problem = errorText(error) }
    }

    public var heading: String { "\(projects.isEmpty ? "Stickies" : "Projects and stickies") in the trash are deleted a week after they’re thrown away." }
}
