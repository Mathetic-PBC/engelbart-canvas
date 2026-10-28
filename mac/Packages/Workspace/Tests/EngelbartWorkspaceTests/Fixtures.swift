import XCTest
import AppKit
import EngelbartCore
import EngelbartStore
import EngelbartStage
@testable import EngelbartWorkspace

// Test data: trees, notes and library rows decoded from the JSON shapes the Store answers, and a fake api.* that keeps
// what it was asked and answers from memory. No network, no disk outside temporary directories.

enum Fx {
    static let project = "11111111-1111-4111-8111-111111111111"
    static let w1 = "aaaaaaaa-0000-4000-8000-000000000001"
    static let w2 = "aaaaaaaa-0000-4000-8000-000000000002"
    static let w3 = "aaaaaaaa-0000-4000-8000-000000000003" // child of w1
    static let n1 = "bbbbbbbb-0000-4000-8000-000000000001"
    static let n2 = "bbbbbbbb-0000-4000-8000-000000000002"
    static let pdf = "cccccccc-0000-4000-8000-000000000001"

    static func node(_ id: String, _ name: String, context: [String] = [], removed: [String] = [], picked: [String] = [], children: [JSONValue] = []) -> JSONValue {
        ["id": .string(id), "name": .string(name), "context": .array(context.map { .string($0) }), "removed": .array(removed.map { .string($0) }),
         "picked": .array(picked.map { .string($0) }), "chars": 0, "builds": [], "archives": [], "created": "2026-10-01T00:00:00.000Z",
         "folder": .string(name), "edited": .null, "children": .array(children)]
    }

    static func tree(directory: String? = "/tmp/code", nodes: [JSONValue]? = nil, notes: [JSONValue]? = nil) -> ProjectTree {
        let json: JSONValue = [
            "project": ["id": .string(project), "name": "Thesis", "slug": "thesis", "dir": "/tmp/root/Thesis", "created": .null,
                        "directory": directory.map { .string($0) } ?? .null, "directoryMissing": .null, "description": ""],
            "workspaces": .array(nodes ?? [node(w1, "Reading", context: [pdf], children: [node(w3, "Untitled Project 1")]), node(w2, "Writing")]),
            "notes": .array(notes ?? [
                ["id": .string(n1), "name": "Ideas", "path": "/tmp/root/Thesis/notes/Ideas.md", "workspaceId": .string(w1), "created": "2026-10-01T00:00:00.000Z", "lastEdited": "2026-10-02T00:00:00.000Z"],
                ["id": .string(n2), "name": "Untitled Note 1", "path": "/tmp/root/Thesis/notes/Untitled Note 1.md", "workspaceId": .null, "created": "2026-10-01T00:00:00.000Z", "lastEdited": "2026-10-03T00:00:00.000Z"],
            ]),
            "trash": [],
        ]
        return try! JSONDecoder().decode(ProjectTree.self, from: Data(json.text().utf8))
    }

    static func row(_ id: String, _ name: String, type: String = "md", tags: [String] = [], path: String? = nil, url: String? = nil, edited: String = "2026-10-01T00:00:00.000Z", projectId: String? = project) -> LibraryRow {
        LibraryRow(id: id, name: name, type: type, path: path, url: url, projectId: projectId, created: "2026-09-01T00:00:00.000Z", lastEdited: edited, tags: tags)
    }

    static var library: [LibraryRow] {
        [row(n1, "Ideas", tags: ["note"], path: "/tmp/root/Thesis/notes/Ideas.md", edited: "2026-10-02T00:00:00.000Z"),
         row(n2, "Untitled Note 1", tags: ["note"], edited: "2026-10-03T00:00:00.000Z"),
         row(pdf, "Kapur 2008", type: "pdf", tags: ["paper"], path: "/tmp/papers/kapur.pdf")]
    }

    static func storage() -> UserDefaults {
        let name = "workspace-tests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    @MainActor
    static func context(_ api: FakeAPI, tree: ProjectTree = Fx.tree(), library: [LibraryRow] = Fx.library, entry: WorkspaceEntry = WorkspaceEntry(workspaceId: Fx.w1),
                        hub: EventHub = EventHub()) -> WorkspaceContext {
        var ctx = WorkspaceContext(api: api, tree: tree, library: library, entry: entry) { [weak api] in
            guard let api else { return nil }
            api.reloads += 1
            return (api.tree ?? tree, api.rows ?? library)
        }
        ctx.storage = storage()
        ctx.hub = hub
        ctx.makeTerminal = { _ in nil }
        ctx.onError = { [weak api] m in api?.errors.append(m) }
        ctx.onClose = { [weak api] in api?.closed += 1 }
        ctx.onVisit = { [weak api] id in api?.visits.append(id) }
        return ctx
    }
}

/// A run loop turn or a few: what the model scheduled on the main queue happens.
@MainActor
func settle(_ seconds: Double = 0.05) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }

@MainActor
final class FakeAPI: WorkspaceAPI {
    var docsOnDisk: [String: String] = [:]
    var writes: [(key: String, text: String)] = []
    var revision: Double = 0
    var views: [(wid: String, view: JSONValue)] = []
    var edits: [String] = []
    var errors: [String] = []
    var closed = 0
    var visits: [String] = []
    var reloads = 0
    var tree: ProjectTree?
    var rows: [LibraryRow]?
    var navState = NavState()
    var seen: [String] = []
    var asked: [JSONValue] = []
    var askAnswer: (JSONValue) async throws -> JSONValue = { _ in ["lines": ["bart> An answer."], "meta": [:]] }
    var routeAnswer: JSONValue? = nil
    var routeFails = false
    var named: [JSONValue] = []
    var buildsStarted: [JSONValue] = []
    var buildCalls: [String] = []
    var reviewAnswer: JSONValue = ["files": []]
    var cleared: [String] = []
    var copied: [String] = []
    var linked: [(ids: [String], picked: Bool)] = []
    var unlinked: [(id: String, unmentioned: Bool)] = []
    var notesMade: [String] = []
    var stopped: [String] = []
    var lookups: [String: LibraryLookup] = [:]
    var addAnswer: ((String) throws -> LibraryRow)?
    var folderList: [JSONValue] = []
    var trashRects: [CGRect?] = []
    var walkState: JSONValue? = nil
    var openedExternal: [String] = []

    static func key(_ ref: StoreDocRef) -> String { ref.key }

    func readDoc(_ projectId: String, _ ref: StoreDocRef) async throws -> String { docsOnDisk[ref.key] ?? "" }
    func writeDoc(_ projectId: String, _ ref: StoreDocRef, _ text: String) async throws -> Double? {
        writes.append((ref.key, text)); docsOnDisk[ref.key] = text; revision += 1; return revision
    }
    func readArchive(_ projectId: String, _ workspaceId: String, _ file: String) async throws -> String { "archived \(file)" }
    func clearWorkspace(_ projectId: String, _ workspaceId: String) async throws -> (text: String, revision: Double?) { cleared.append(workspaceId); revision += 1; return ("", revision) }
    func restoreArchive(_ projectId: String, _ workspaceId: String, _ file: String) async throws -> (text: String, revision: Double?) { revision += 1; return ("restored \(file)", revision) }
    func copyDoc(_ projectId: String, _ ref: PaneRef) async throws -> (files: Int, missing: Int) { copied.append(ref.json.text()); return (2, 1) }
    func readImage(_ id: String) async throws -> (data: Data, mime: String) { throw WorkspaceError("no image") }
    func saveImage(_ projectId: String, data: Data, mime: String, name: String?) async throws -> LibraryRow { Fx.row("dddddddd-0000-4000-8000-000000000001", name ?? "Attachment 1", type: "image") }
    func setView(_ projectId: String, _ workspaceId: String, _ view: JSONValue) async { views.append((workspaceId, view)) }
    func recordEdit(_ projectId: String, _ workspaceId: String) async { edits.append(workspaceId) }
    func nav() async throws -> NavState { navState }
    func seenAgents(_ projectId: String, _ workspaceId: String) async { seen.append(workspaceId) }
    func starred(_ projectId: String) async throws -> [String] { [] }
    func setStarred(_ projectId: String, _ itemId: String, _ on: Bool) async throws -> [String] { on ? [itemId] : [] }
    func folders() async throws -> [JSONValue] { folderList }
    func addToFolder(_ folderId: String, _ ids: [String]) async throws -> [JSONValue] { folderList }
    func removeFromFolder(_ folderId: String, _ id: String) async throws -> [JSONValue] { folderList }
    func createFolder(_ name: String) async throws -> [JSONValue] { folderList.append(["id": "f1", "name": .string(name), "items": []]); return folderList }
    func renameFolder(_ folderId: String, _ name: String) async throws -> [JSONValue] { folderList }
    func deleteFolder(_ folderId: String) async throws -> [JSONValue] { folderList }
    func gettingStarted(_ projectId: String) async throws -> JSONValue? { walkState }
    func setGettingStarted(_ projectId: String, tick: [Int], untick: [Int], hidden: Bool) async throws -> JSONValue? { nil }
    var createdWorkspaces: [String] = []
    func createWorkspace(_ projectId: String, name: String, parentId: String?) async throws -> String { createdWorkspaces.append(name); return Fx.w2 }
    func renameWorkspace(_ projectId: String, _ workspaceId: String, _ name: String) async throws {}
    var trashed: [String] = []
    func trashWorkspace(_ projectId: String, _ workspaceId: String) async throws { trashed.append(workspaceId) }
    func restoreWorkspace(_ projectId: String, _ workspaceId: String) async throws {}
    func renameProject(_ projectId: String, _ name: String) async throws {}
    func createNote(_ projectId: String, name: String, workspaceId: String?) async throws -> NoteInfo {
        notesMade.append(name)
        let json: JSONValue = ["id": "eeeeeeee-0000-4000-8000-000000000001", "name": .string(name), "path": "/tmp/n.md", "workspaceId": workspaceId.map { .string($0) } ?? .null, "created": "", "lastEdited": ""]
        return try JSONDecoder().decode(NoteInfo.self, from: Data(json.text().utf8))
    }
    func renameNote(_ projectId: String, _ id: String, _ name: String) async throws -> String { name }
    func linkToWorkspace(_ projectId: String, _ workspaceId: String, _ ids: [String], picked: Bool) async throws -> String? { linked.append((ids, picked)); return nil }
    func unlinkFromWorkspace(_ projectId: String, _ workspaceId: String, _ id: String, unmentioned: Bool) async throws { unlinked.append((id, unmentioned)) }
    func library() async throws -> [LibraryRow] { rows ?? Fx.library }
    func addLibraryItem(_ input: String, name: String?) async throws -> (row: LibraryRow, sandboxError: String?) {
        if let a = addAnswer { return (try a(input), nil) }
        return (Fx.row("ffffffff-0000-4000-8000-000000000001", name ?? input, type: "website", url: input), nil)
    }
    func addLibraryFile(_ data: Data, mime: String, name: String?) async throws -> LibraryRow { Fx.row("ffffffff-0000-4000-8000-000000000002", name ?? "file", type: "image") }
    func addLibraryUrl(_ input: String) async throws -> (row: LibraryRow, sandboxError: String?) { (Fx.row("ffffffff-0000-4000-8000-000000000003", input, type: "website", url: input), nil) }
    func addLibraryPdf(_ input: String, bytes: Data, name: String?) async throws -> LibraryRow { Fx.row("ffffffff-0000-4000-8000-000000000004", name ?? "pdf", type: "pdf") }
    func addLibraryPage(_ tabId: String, _ input: String, name: String?) async throws -> LibraryRow { Fx.row("ffffffff-0000-4000-8000-000000000005", name ?? "page", type: "html") }
    func lookupLibraryItem(_ input: String) async throws -> LibraryLookup { lookups[input] ?? LibraryLookup(type: "website", tags: []) }
    func renameLibraryItem(_ id: String, _ name: String) async throws -> LibraryRow? { nil }
    func pickLibraryPaths() async -> [String] { [] }
    func listFolder(_ id: String, _ rel: String) async throws -> JSONValue { ["entries": []] }
    func folderFile(_ folderId: String, _ rel: String) async throws -> (exists: Bool, path: String?, folder: String?) { (false, nil, "Papers") }
    func libraryBodies(_ projectId: String) async throws -> MentionRows.Bodies { MentionRows.Bodies() }
    func readLibraryFile(_ id: String) async throws -> Data { Data() }
    func readAnnotations(_ id: String) async throws -> JSONValue? { nil }
    func writeAnnotations(_ id: String, _ value: JSONValue) async throws {}
    func readPageAnnotations(_ url: String) async throws -> JSONValue? { nil }
    func writePageAnnotations(_ url: String, _ value: JSONValue) async throws {}
    func readStageFile(_ projectId: String, _ input: String) async throws -> StageFile { throw WorkspaceError("Nothing is at that path") }
    func stage(_ projectId: String) async -> JSONValue? { nil }
    func setStage(_ projectId: String, _ value: JSONValue) async {}
    func bartModels() async throws -> JSONValue { [:] }
    func askBart(_ projectId: String, _ input: JSONValue) async throws -> JSONValue { asked.append(input); return try await askAnswer(input) }
    func runningPaperAsks(_ projectId: String) async throws -> [JSONValue] { [] }
    func routeLine(_ projectId: String, _ input: JSONValue) async throws -> JSONValue? { if routeFails { throw WorkspaceError("router down") }; return routeAnswer }
    var handed: [(String, String)] = []
    func routeHanded(_ routeId: String, _ to: String) async { handed.append((routeId, to)) }
    func stopBart(_ askId: String) async throws { stopped.append(askId) }
    func nameChat(_ input: JSONValue) async throws -> String? { named.append(input); return "A title" }
    func createdFile(_ projectId: String, _ askId: String, _ rel: String) async throws -> JSONValue { ["name": .string(rel), "type": "html", "ext": "html", "path": .string("/tmp/.created/\(askId)/\(rel)")] }
    func saveCreated(_ projectId: String, _ askId: String, _ rel: String, _ workspaceId: String?) async throws -> LibraryRow { Fx.row("99999999-0000-4000-8000-000000000001", rel, type: "html") }
    var buildCounter = 0
    func buildList(_ projectId: String) async throws -> [JSONValue] { [] }
    func buildStart(_ projectId: String, _ input: JSONValue) async throws -> JSONValue {
        buildsStarted.append(input); buildCounter += 1
        return ["id": .string("b\(buildCounter)"), "projectId": .string(projectId), "status": "running", "title": "A Build", "kind": input["kind"] ?? "build"]
    }
    func buildReply(_ projectId: String, _ id: String, _ text: String, interrupt: Bool, images: [JSONValue]) async throws { buildCalls.append("reply:\(text)") }
    func buildStop(_ projectId: String, _ id: String) async throws { buildCalls.append("stop") }
    func buildResume(_ projectId: String, _ id: String) async throws { buildCalls.append("resume") }
    func buildFix(_ projectId: String, _ id: String) async throws { buildCalls.append("fix") }
    func buildDiscard(_ projectId: String, _ id: String) async throws { buildCalls.append("discard") }
    func buildAccept(_ projectId: String, _ id: String) async throws { buildCalls.append("accept"); throw WorkspaceError("refused") }
    func buildReview(_ projectId: String, _ id: String) async throws -> JSONValue { buildCalls.append("review"); return reviewAnswer }
    func buildRunShow(_ projectId: String, _ id: String, _ name: String) async throws { buildCalls.append("runshow:\(name)") }
    func buildRunStop(_ projectId: String, _ id: String) async throws { buildCalls.append("runstop") }
    func buildRunStopRunnable(_ projectId: String, _ id: String, _ name: String?) async throws { buildCalls.append("runstopone:\(name ?? "all")") }
    func buildPromote(_ projectId: String, _ id: String, _ workspaceId: String, choice: JSONValue?) async throws -> JSONValue { ["id": .string(id), "projectId": .string(projectId), "status": "running"] }
    func zoteroList(_ rel: String) async throws -> JSONValue { ["entries": []] }
    var zoteroAnswer: JSONValue = ["path": "/tmp/z.pdf"]
    func zoteroOpen(_ key: String) async throws -> JSONValue { zoteroAnswer }
    func zoteroAttach(_ key: String, _ file: String) async throws -> JSONValue { zoteroAnswer }
    func openExternal(_ url: String) { openedExternal.append(url) }
    var copiedText: [String] = []
    func copyText(_ text: String) { copiedText.append(text) }
    func startSandbox(_ libraryId: String) async throws {}
    func connectDismiss(_ sessionId: String) async {}
    var reveal: JSONValue? = nil
    func takeAgentReveal(_ projectId: String) async -> JSONValue? { defer { reveal = nil }; return reveal }
    func postItsTrashRect(_ rect: CGRect?) { trashRects.append(rect) }
    func postItsThrowOut(_ projectId: String, _ postItId: String) async throws {}
}

/// A fake editor for the model's editor handles.
@MainActor
final class FakeEditor: EditorHandle {
    var handleKey: String?
    var handleLines: [String] = []
    var shown: [(Int, Bool)] = []
    var passages: [(Int, String)] = []
    var discovered: [String?] = []
    var boxed: [String] = []
    var started: [String] = []
    var focusedEnd = 0
    var active = false
    init(_ key: String?, _ lines: [String] = []) { handleKey = key; handleLines = lines }
    func handleShowLine(_ i: Int, flash: Bool) -> Bool { shown.append((i, flash)); return true }
    func handleShowPassage(_ i: Int, find: String) -> Bool { passages.append((i, find)); return true }
    func handleDiscoverLastResult(_ askId: String?) -> Bool { discovered.append(askId); return true }
    func handleAskBoxed(_ askId: String) -> Bool { boxed.append(askId); return true }
    func handleStartAgent(_ agent: String) -> Bool { started.append(agent); return true }
    func handleFocusEnd() { focusedEnd += 1 }
    func handleFocusStart() {}
    var handleIsActive: Bool { active }
    func handleShutMenus() -> Bool { false }
    func handleCaretNow() -> (line: Int, a: Int, b: Int)? { nil }
}
