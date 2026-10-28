import XCTest
import EngelbartCore
@testable import EngelbartStore

/// test/projects.test.cjs, test/sidebar-store.test.cjs, test/project-library.test.cjs (store parts), windows places.
final class ProjectsTests: XCTestCase {
    var ctx: StoreContext!
    var layout: Home.Layout!
    var home: String!
    let PNG = hex("89504e470d0a1a0a0000000d4948445200000001000000010806000000")
    static let week = 7.0 * 24 * 60 * 60

    override func setUpWithError() throws { (ctx, layout, home) = try makeContext("engelbart-projects-") }
    override func tearDown() { SQLiteRegistry.closeAll() }

    func testCreateListRenameMovesDirectoryAndRewritesNotePaths() throws {
        let created = try Projects.create(ctx, "Thesis/2026")
        XCTAssertEqual(created.name, "Thesis-2026"); XCTAssertEqual(created.slug, "thesis-2026"); XCTAssertNil(created.directory)
        XCTAssertTrue(exists(Paths.join(layout.testRoot, "thesis-2026", "notes.sqlite")))
        XCTAssertEqual(read(Paths.join(created.dir, ".project.md")), "")
        let note = try Documents.createNote(ctx, created.id, name: "First")
        let renamed = try Projects.renameProject(ctx, created.id, "Dissertation")
        XCTAssertEqual(renamed.slug, "dissertation")
        XCTAssertEqual(try ctx.libraryDb.get(note.id)?.path, Paths.join(layout.testRoot, "dissertation", "First.md"))
        XCTAssertTrue(try Projects.listProjects(ctx).contains { $0.id == created.id && $0.workspaceCount == 0 })
        let custom = try Projects.createProject(ctx, .init(name: "Reading Group", path: "rg-2026"))
        XCTAssertEqual(custom.slug, "rg-2026")
        XCTAssertEqual(try Projects.renameProject(ctx, custom.id, "Reading Circle").slug, "rg-2026", "a custom path keeps its directory")
    }

    func testCodeDirectory() throws {
        let code = tempDir("engelbart-code-")
        let created = try Projects.createProject(ctx, .init(name: "With Code", directory: code))
        XCTAssertEqual(created.directory, code)
        XCTAssertEqual(json(Paths.join(created.dir, "project.json"))?["directory"]?.string, code)
        let bare = try Projects.create(ctx, "No Code Yet")
        XCTAssertThrowsMatchingSync({ try Projects.setProjectDirectory(ctx, bare.id, "relative/path") }, "absolute")
        XCTAssertThrowsMatchingSync({ try Projects.setProjectDirectory(ctx, bare.id, Paths.join(code, "missing")) }, "does not exist")
        XCTAssertEqual(try Projects.setProjectDirectory(ctx, bare.id, code).directory, code)
        XCTAssertEqual(try Projects.loadProject(ctx, bare.id).project.directory, code)
        try FileManager.default.removeItem(atPath: code)
        let gone = try Projects.loadProject(ctx, bare.id).project
        XCTAssertNil(gone.directory); XCTAssertEqual(gone.directoryMissing, code)
        XCTAssertThrowsMatchingSync({ try Projects.find(ctx, "nope") }, "project id is invalid")
        XCTAssertThrowsMatchingSync({ try Projects.find(ctx, uuid()) }, "Unknown project")
    }

    func testWelcomeProjectAndWelcomePage() throws {
        let made = try Projects.createProjectWithWelcome(ctx, .init(name: "Welcome Test", description: "Why."))
        let tree = try Projects.loadProject(ctx, made.project.id)
        XCTAssertEqual(tree.workspaces.count, 1); XCTAssertEqual(tree.workspaces[0].name, "Getting started")
        XCTAssertEqual(tree.workspaces[0].context, [made.noteId!])
        XCTAssertEqual(tree.notes[0].workspaceId, made.workspaceId)
        XCTAssertTrue(exists(Paths.join(made.project.dir, "Welcome!.md")))
        XCTAssertEqual(read(Paths.join(made.project.dir, "Welcome!.md")), Projects.welcomeNote)
        XCTAssertEqual(try Documents.readDoc(ctx, made.project.id, .workspace(workspaceId: made.workspaceId)), "Why.\n")
        let page = try Projects.createProjectWithWelcomePage(ctx, .init(name: "First one"), context: [])
        let doc = try Documents.readDoc(ctx, page.project.id, .workspace(workspaceId: page.workspaceId))
        XCTAssertTrue(doc.hasPrefix("![Attachment 1](img:"), "the picture first")
        XCTAssertTrue(doc.contains("*Thanks for being a beta user* :)"))
        XCTAssertEqual(try Projects.loadProject(ctx, page.project.id).workspaces[0].name, "Welcome to Engelbart!")
        XCTAssertEqual(try Projects.loadProject(ctx, page.project.id).notes.count, 0, "no Welcome! note")
        let image = try ctx.libraryDb.list().first { $0.type == "image" && $0.projectId == page.project.id }!
        XCTAssertEqual(try Documents.readImage(ctx, image.id).mime, "image/png")
    }

    func testWorkspacesNestDocsContextRenames() throws {
        let project = try Projects.create(ctx, "Nesting")
        let top = try Workspaces.create(ctx, project.id, name: "User Interface")
        let child = try Workspaces.create(ctx, project.id, name: "Terminal", parentId: top.id)
        let grandchild = try Workspaces.create(ctx, project.id, name: "History", parentId: child.id)
        XCTAssertTrue(exists(Paths.join(project.dir, "User Interface", "Terminal", "History", "meta.json")))
        try Documents.writeDoc(ctx, project.id, .workspace(workspaceId: grandchild.id), "# deep\n")
        XCTAssertEqual(try Documents.readDoc(ctx, project.id, .workspace(workspaceId: grandchild.id)), "# deep\n")
        XCTAssertNil(JSONValue.encode(try Workspaces.rename(ctx, project.id, child.id, "Terminal"))["status"], "workspaces have no status to set")
        let note = try Documents.createNote(ctx, project.id, name: "Reading", workspaceId: grandchild.id)
        XCTAssertTrue(exists(Paths.join(project.dir, "Reading.md")), "notes stay flat")
        XCTAssertEqual(try Workspaces.setContext(ctx, project.id, grandchild.id, [note.id]).context, [note.id])
        XCTAssertEqual(try Workspaces.rename(ctx, project.id, child.id, "Shell").name, "Shell")
        XCTAssertTrue(exists(Paths.join(project.dir, "User Interface", "Shell", "History", "workspace.md")))
        XCTAssertEqual(try Workspaces.create(ctx, project.id, name: "assets").name, "assets workspace")
        let tree = try Projects.loadProject(ctx, project.id)
        let ui = tree.workspaces.first { $0.id == top.id }!
        XCTAssertEqual(ui.children[0].name, "Shell"); XCTAssertEqual(ui.children[0].children[0].id, grandchild.id)
        XCTAssertEqual(try Projects.listProjects(ctx).first { $0.id == project.id }?.workspaceCount, 4)
        XCTAssertThrowsMatchingSync({ try Workspaces.create(ctx, project.id, name: "x", parentId: "00000000-0000-4000-8000-000000000000") }, "Unknown workspace")
    }

    func testFourLevelsDeep() throws {
        let top = try Projects.create(ctx, "Depth")
        let two = try Workspaces.create(ctx, top.id, name: "Two")
        let three = try Workspaces.create(ctx, top.id, name: "Three", parentId: two.id)
        let four = try Workspaces.create(ctx, top.id, name: "Four", parentId: three.id)
        XCTAssertThrowsMatchingSync({ try Workspaces.create(ctx, top.id, name: "Five", parentId: four.id) }, "four levels deep")
        XCTAssertNoThrow(try Workspaces.create(ctx, top.id, name: "Also four", parentId: three.id))
    }

    func testProjectPage() throws {
        let made = try Projects.createProject(ctx, .init(name: "Paged", description: "What this project is for."))
        XCTAssertEqual(read(Paths.join(made.dir, Projects.projectPage)), "What this project is for.\n")
        XCTAssertEqual(try Documents.readDoc(ctx, made.id, .project), "What this project is for.\n")
        XCTAssertEqual(Documents.projectPageBlock(try Projects.find(ctx, made.id)), "", "only the description: nothing to add")
        try Documents.writeDoc(ctx, made.id, .project, "Every agent here reads this first.\n")
        XCTAssertEqual(try Documents.readDoc(ctx, made.id, .project), "Every agent here reads this first.\n")
        XCTAssertTrue(Documents.projectPageBlock(try Projects.find(ctx, made.id)).hasPrefix("<project_page name=\"Paged\""))
        XCTAssertEqual(try Projects.loadProject(ctx, made.id).workspaces.count, 0)
        try FileManager.default.removeItem(atPath: Paths.join(made.dir, Projects.projectPage))
        XCTAssertEqual(try Documents.readDoc(ctx, made.id, .project), "What this project is for.\n", "made on first read")
        XCTAssertNotEqual(try Documents.createNote(ctx, made.id, name: ".project").path, Projects.projectPage)
    }

    func testWorkspaceTrashRestorePurge() throws {
        let project = try Projects.create(ctx, "Trash Can")
        let top = try Workspaces.create(ctx, project.id, name: "Plans")
        let child = try Workspaces.create(ctx, project.id, name: "Draft", parentId: top.id)
        let grandchild = try Workspaces.create(ctx, project.id, name: "Notes", parentId: child.id)
        try Documents.writeDoc(ctx, project.id, .workspace(workspaceId: child.id), "kept\n")
        let trashed = try Workspaces.trash(ctx, project.id, child.id)
        XCTAssertEqual([trashed.id, trashed.name], [child.id, "Draft"])
        var tree = try Projects.loadProject(ctx, project.id)
        XCTAssertEqual(tree.workspaces.first { $0.id == top.id }?.children, [])
        XCTAssertThrowsMatchingSync({ try Workspaces.find(ctx, project.id, grandchild.id) }, "Unknown workspace")
        XCTAssertEqual(tree.trash.count, 1)
        XCTAssertEqual([tree.trash[0].id, tree.trash[0].name], [child.id, "Draft"]); XCTAssertEqual(tree.trash[0].nested, 1)
        try Workspaces.create(ctx, project.id, name: "Draft", parentId: top.id)
        XCTAssertEqual(try Workspaces.restore(ctx, project.id, child.id).name, "Draft 2")
        XCTAssertEqual(try Documents.readDoc(ctx, project.id, .workspace(workspaceId: child.id)), "kept\n")
        XCTAssertNil(json(Paths.join(project.dir, "Plans", "Draft 2", "meta.json"))?["trashed"])
        XCTAssertEqual(try Workspaces.trashed(ctx, project.id), [])
        XCTAssertThrowsMatchingSync({ try Workspaces.restore(ctx, project.id, child.id) }, "no longer in the trash")
        try Workspaces.trash(ctx, project.id, child.id)
        try Workspaces.trash(ctx, project.id, top.id)
        XCTAssertEqual(try Workspaces.restore(ctx, project.id, child.id).name, "Draft 2")
        XCTAssertTrue(exists(Paths.join(project.dir, "Draft 2", "Notes", "meta.json")))
        XCTAssertEqual(try Workspaces.trashed(ctx, project.id, now: Date().addingTimeInterval(8 * 24 * 3600)).count, 0)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: Paths.join(project.dir, ".trash")).count, 0, "purged from disk")
        _ = tree; tree = try Projects.loadProject(ctx, project.id)
    }

    /// A project with a code folder, a workspace with a document, a note, a pasted image and a view in state.json.
    func trashable(_ name: String) throws -> (code: String, project: PublicProject, workspace: PublicWorkspace, note: NoteInfo, image: LibraryRow) {
        let code = tempDir("engelbart-trash-code-")
        write(Paths.join(code, "main.py"), "print(1)\n")
        let project = try Projects.createProject(ctx, .init(name: name, directory: code))
        let workspace = try Workspaces.create(ctx, project.id, name: "Plans")
        try Documents.writeDoc(ctx, project.id, .workspace(workspaceId: workspace.id), "the plan\n")
        let note = try Documents.createNote(ctx, project.id, name: "Ideas", workspaceId: workspace.id, text: "an idea\n")
        let image = try Documents.saveImage(ctx, project.id, bytes: PNG, mime: "image/png", name: "Sketch")
        try AppState.writeView(ctx.dataRoot, project.id, workspace.id, ["active": .string(note.id), "tabs": [["id": .string(note.id), "title": "Ideas"]], "positions": [:]])
        try AppState.writeStage(ctx.dataRoot, project.id, ["active": 0, "tabs": [["address": "https://example.org/", "title": "Example"]]])
        return (code, project, workspace, note, image)
    }

    func record(_ project: PublicProject, _ id: String, status: String = "review", worktree: String? = nil, inside: String = "") throws {
        let tree = worktree ?? Paths.join(layout.testRoot, "worktrees", project.slug, id)
        try BuildRecords.write(project.dir, ["id": .string(id), "kind": "build", "projectId": .string(project.id), "status": .string(status), "title": "T", "repo": "/nowhere",
                                             "worktree": .string(tree), "cwd": .string(inside.isEmpty ? tree : Paths.join(tree, inside)), "branch": .string("engelbart/\(id)"), "messages": [], "created": .string(Time.iso())])
    }

    func testProjectTrashAndRestore() async throws {
        let t = try trashable("Old Thesis")
        let before = read(Paths.join(t.code, "main.py"))
        var stopped: [String] = []
        let out = try await Projects.trashProject(ctx, t.project.id) { id in stopped.append(id) }
        XCTAssertEqual([out.id, out.name], [t.project.id, "Old Thesis"]); XCTAssertEqual(stopped, [t.project.id])
        let into = Paths.join(layout.testRoot, ".trash", t.project.slug)
        XCTAssertFalse(exists(t.project.dir)); XCTAssertTrue(exists(Paths.join(into, "Plans", "workspace.md")))
        XCTAssertFalse(try Projects.listProjects(ctx).contains { $0.id == t.project.id })
        XCTAssertEqual(try ctx.libraryDb.get(t.note.id)?.path, Paths.join(into, "Ideas.md"))
        XCTAssertEqual(try ctx.libraryDb.get(t.image.id)?.path, Paths.join(into, "assets", Paths.basename(t.image.path!)))
        let trashedMeta = json(Paths.join(into, "project.json"))!["trashed"]!
        XCTAssertEqual([trashedMeta["slug"], trashedMeta["name"]], [.string(t.project.slug), .string(t.project.slug)])
        let mine = try await Projects.trashedProjects(ctx).first { $0.id == t.project.id }!
        XCTAssertEqual(mine.name, "Old Thesis"); XCTAssertEqual(mine.workspaceCount, 1)
        XCTAssertEqual(Time.parse(mine.expires)!.timeIntervalSince(Time.parse(mine.deleted)!), Self.week)
        let back = try await Projects.restoreProject(ctx, t.project.id)
        XCTAssertEqual([back.id, back.slug, back.dir, back.directory], [t.project.id, t.project.slug, t.project.dir, t.code]); XCTAssertEqual(back.workspaceCount, 1)
        XCTAssertEqual(try Documents.readDoc(ctx, t.project.id, .note(id: t.note.id)), "an idea\n")
        XCTAssertEqual(try Projects.loadProject(ctx, t.project.id).notes.map(\.id), [t.note.id])
        XCTAssertEqual(try ctx.libraryDb.get(t.note.id)?.path, Paths.join(t.project.dir, "Ideas.md"))
        XCTAssertEqual(try ctx.libraryDb.get(t.image.id)?.path, t.image.path)
        XCTAssertEqual(try Documents.readImage(ctx, t.image.id).bytes, PNG)
        XCTAssertNil(json(Paths.join(t.project.dir, "project.json"))?["trashed"])
        XCTAssertNotNil(AppState.readViews(ctx.dataRoot, t.project.id)[t.workspace.id], "its views were kept")
        XCTAssertEqual(AppState.readStage(ctx.dataRoot, t.project.id)["tabs"]?.array?.count, 1)
        XCTAssertEqual(read(Paths.join(t.code, "main.py")), before, "the code folder is untouched")
        await XCTAssertThrowsMatching({ try await Projects.restoreProject(ctx, t.project.id) }, "no longer in the trash")
    }

    func testRestoreWhenTheNameIsTakenMovesOpenBuildWorktrees() async throws {
        let t = try trashable("Taken")
        for id in ["aaaaaaaaa1", "aaaaaaaaa2", "aaaaaaaaa3", "aaaaaaaaa4"] { try FileManager.default.createDirectory(atPath: Paths.join(layout.testRoot, "worktrees", t.project.slug, id), withIntermediateDirectories: true) }
        try record(t.project, "aaaaaaaaa1", inside: "app")
        try record(t.project, "aaaaaaaaa2", status: "accepted")
        try record(t.project, "aaaaaaaaa3", status: "stopped")
        try record(t.project, "aaaaaaaaa4", worktree: Paths.join(layout.testRoot, "worktrees", t.project.slug, "gone-away"))
        try await Projects.trashProject(ctx, t.project.id)
        let other = try Projects.create(ctx, "Taken")
        XCTAssertEqual(other.slug, t.project.slug)
        let moves = Box<[String]>([]), removed = Box<[String]>([])
        let back = try await Projects.restoreProject(ctx, t.project.id, moveWorktree: { task, to in
            if task["id"]?.string == "aaaaaaaaa3" { throw StoreError("locked") }
            moves.value.append(task["id"]!.string!)
            try FileManager.default.createDirectory(atPath: Paths.dirname(to), withIntermediateDirectories: true)
            try FileManager.default.moveItem(atPath: task["worktree"]!.string!, toPath: to)
        }, removeWorktrees: { tasks in removed.value.append(contentsOf: tasks.compactMap { $0["id"]?.string }) })
        XCTAssertEqual(back.slug, "\(t.project.slug) 2"); XCTAssertEqual(back.name, "Taken")
        func at(_ id: String) -> String { Paths.join(layout.testRoot, "worktrees", back.slug, id) }
        XCTAssertEqual(moves.value, ["aaaaaaaaa1"])
        let tasks = Dictionary(uniqueKeysWithValues: BuildRecords.list(back.dir).map { ($0["id"]!.string!, $0) })
        XCTAssertEqual([tasks["aaaaaaaaa1"]?["worktree"], tasks["aaaaaaaaa1"]?["cwd"], tasks["aaaaaaaaa1"]?["status"]], [.string(at("aaaaaaaaa1")), .string(Paths.join(at("aaaaaaaaa1"), "app")), "review"])
        XCTAssertEqual(tasks["aaaaaaaaa2"]?["worktree"]?.string, Paths.join(layout.testRoot, "worktrees", t.project.slug, "aaaaaaaaa2"))
        XCTAssertEqual(tasks["aaaaaaaaa3"]?["status"], "discarded"); XCTAssertEqual(removed.value, ["aaaaaaaaa3"])
        XCTAssertNotNil(tasks["aaaaaaaaa3"]?["messages"]?.array?.last?["text"]?.string?.range(of: "could not be moved .*locked.*discarded", options: .regularExpression))
        XCTAssertEqual(tasks["aaaaaaaaa4"]?["worktree"]?.string, at("aaaaaaaaa4"))
        XCTAssertEqual(try ctx.libraryDb.get(t.note.id)?.path, Paths.join(back.dir, "Ideas.md"))
        XCTAssertEqual(try Projects.find(ctx, other.id).dir, t.project.dir)
    }

    func testPurgeAfterAWeek() async throws {
        let t = try trashable("Short Lived")
        try record(t.project, "bbbbbbbbb1")
        try record(t.project, "bbbbbbbbb2", status: "discarded")
        try record(t.project, "bbbbbbbbb3", status: "accepted")
        try BuildRecords.write(t.project.dir, BuildRecords.read(t.project.dir, "bbbbbbbbb3")!.merging(["keptCopy": true]))
        try AppState.recordEdit(ctx, t.project.id, t.workspace.id)
        let kept = try Projects.create(ctx, "Not deleted")
        let keptNote = try Documents.createNote(ctx, kept.id, name: "Stays")
        try AppState.setStarred(ctx.dataRoot, t.project.id, t.note.id, true)
        try AppState.setStarred(ctx.dataRoot, kept.id, keptNote.id, true)
        try await Projects.trashProject(ctx, t.project.id)
        let removed = Box<[String]>([])
        let remove: @Sendable ([JSONValue]) async throws -> Void = { tasks in removed.value.append(contentsOf: tasks.compactMap { $0["id"]?.string }) }
        let notYet = try await Projects.trashedProjects(ctx, now: Date().addingTimeInterval(Self.week - 60), removeWorktrees: remove)
        XCTAssertTrue(notYet.contains { $0.id == t.project.id })
        XCTAssertEqual(removed.value, [])
        let later = try await Projects.trashedProjects(ctx, now: Date().addingTimeInterval(Self.week + 60), removeWorktrees: remove)
        XCTAssertFalse(later.contains { $0.id == t.project.id })
        XCTAssertFalse(exists(Paths.join(layout.testRoot, ".trash", t.project.slug)))
        XCTAssertEqual(removed.value.sorted(), ["bbbbbbbbb1", "bbbbbbbbb3"])
        XCTAssertNil(try ctx.libraryDb.get(t.note.id)); XCTAssertNil(try ctx.libraryDb.get(t.image.id))
        XCTAssertNotNil(try ctx.libraryDb.get(keptNote.id))
        let state = AppState.read(ctx.dataRoot)
        XCTAssertNil(state["views"]?[t.project.id]); XCTAssertNil(state["stages"]?[t.project.id]); XCTAssertNil(state["starred"]?[t.project.id])
        XCTAssertFalse((state["recent"]?.array ?? []).contains { $0["projectId"]?.string == t.project.id })
        XCTAssertEqual(AppState.readStarred(ctx.dataRoot, kept.id), [keptNote.id])
        XCTAssertEqual(read(Paths.join(t.code, "main.py")), "print(1)\n")
        await XCTAssertThrowsMatching({ try await Projects.restoreProject(ctx, t.project.id) }, "no longer in the trash")
    }

    func testCutShortIsFinishedAndCodeInsideRefuses() async throws {
        let first = try trashable("Half Back")
        try await Projects.trashProject(ctx, first.project.id)
        try FileManager.default.moveItem(atPath: Paths.join(layout.testRoot, ".trash", first.project.slug), toPath: first.project.dir)
        XCTAssertTrue(try ctx.libraryDb.get(first.note.id)!.path!.contains(".trash"))
        let listed = try await Projects.trashedProjects(ctx)
        XCTAssertFalse(listed.contains { $0.id == first.project.id })
        XCTAssertEqual(try ctx.libraryDb.get(first.note.id)?.path, Paths.join(first.project.dir, "Ideas.md"))
        XCTAssertNil(json(Paths.join(first.project.dir, "project.json"))?["trashed"])
        let meta = json(Paths.join(first.project.dir, "project.json"))!
        try JSONFiles.write(Paths.join(first.project.dir, "project.json"), meta.merging(["trashed": ["at": .string(Time.iso()), "slug": .string(first.project.slug), "name": .string(first.project.slug)]]))
        let again = try await Projects.restoreProject(ctx, first.project.id)
        XCTAssertEqual(again.dir, first.project.dir)
        XCTAssertNil(json(Paths.join(first.project.dir, "project.json"))?["trashed"])

        let odd = try Projects.create(ctx, "Code Inside")
        try FileManager.default.createDirectory(atPath: Paths.join(odd.dir, "src"), withIntermediateDirectories: true)
        try Projects.setProjectDirectory(ctx, odd.id, Paths.join(odd.dir, "src"))
        let stopped = Box(false)
        await XCTAssertThrowsMatching({ try await Projects.trashProject(ctx, odd.id) { _ in stopped.value = true } }, "code folder is inside")
        XCTAssertFalse(stopped.value); XCTAssertTrue(exists(Paths.join(odd.dir, "src")))
    }

    func testFlatContextAndPickedLinks() throws {
        let project = try Projects.create(ctx, "Folders")
        let w = try Workspaces.create(ctx, project.id, name: "W")
        let note = try Documents.createNote(ctx, project.id, name: "N", workspaceId: w.id)
        let other = try Documents.createNote(ctx, project.id, name: "O", workspaceId: w.id)
        let folder: JSONValue = ["id": "11111111-1111-4111-8111-111111111111", "name": "Reading", "children": [.string(note.id)]]
        XCTAssertEqual(try Workspaces.setContext(ctx, project.id, w.id, [folder, .string(other.id), .string(note.id)]).context, [note.id, other.id])
        XCTAssertThrowsMatchingSync({ try Workspaces.setContext(ctx, project.id, w.id, [42]) }, "id or a folder")

        let p = try Projects.create(ctx, "Picked")
        let ws = try Workspaces.create(ctx, p.id, name: "W")
        let (paper, side, both) = ("21111111-1111-4111-8111-111111111111", "31111111-1111-4111-8111-111111111111", "41111111-1111-4111-8111-111111111111")
        try Workspaces.link(ctx, p.id, ws.id, [side])
        var now = try Workspaces.link(ctx, p.id, ws.id, [paper, side], picked: true)
        XCTAssertEqual(now.context, [side, paper]); XCTAssertEqual(now.picked, [paper])
        now = try Workspaces.unlink(ctx, p.id, ws.id, [paper], unmentioned: true)
        XCTAssertEqual(now.context, [side]); XCTAssertEqual(now.picked, []); XCTAssertEqual(now.removed, [])
        now = try Workspaces.unlink(ctx, p.id, ws.id, [side], unmentioned: true)
        XCTAssertEqual(now.context, [side]); XCTAssertEqual(now.removed, [])
        now = try Workspaces.link(ctx, p.id, ws.id, [paper], picked: true)
        XCTAssertEqual(now.context, [side, paper]); XCTAssertEqual(now.picked, [paper])
        try Workspaces.link(ctx, p.id, ws.id, [both], picked: true)
        now = try Workspaces.link(ctx, p.id, ws.id, [both])
        XCTAssertEqual(now.picked, [paper])
        now = try Workspaces.unlink(ctx, p.id, ws.id, [both], unmentioned: true)
        XCTAssertTrue(now.context.contains(both))
        now = try Workspaces.unlink(ctx, p.id, ws.id, [paper])
        XCTAssertEqual(now.context, [side, both]); XCTAssertEqual(now.picked, []); XCTAssertEqual(now.removed, [paper])
        XCTAssertThrowsMatchingSync({ try Workspaces.link(ctx, p.id, ws.id, ["not-an-id"]) }, "library id is invalid")
    }

    func testPastedImages() throws {
        let project = try Projects.create(ctx, "Images")
        let png = hex("89504e470d0a1a0a0000000d49484452")
        let row = try Documents.saveImage(ctx, project.id, bytes: png, mime: "image/png", name: "Attachment 1")
        XCTAssertEqual(row.type, "image"); XCTAssertEqual(row.projectId, project.id)
        XCTAssertEqual(row.path, Paths.join(project.dir, "assets", "\(row.id).png"))
        XCTAssertEqual(try Documents.readImage(ctx, row.id).mime, "image/png")
        XCTAssertEqual(try Documents.readImage(ctx, row.id).bytes, png)
        XCTAssertThrowsMatchingSync({ try Documents.saveImage(ctx, project.id, bytes: png, mime: "image/svg+xml") }, "png, jpeg, gif and webp")
        XCTAssertThrowsMatchingSync({ try Documents.saveImage(ctx, project.id, bytes: Data(), mime: "image/png") }, "empty")
        XCTAssertEqual(try Projects.loadProject(ctx, project.id).workspaces.count, 0, "assets is not a workspace")
    }

    func testOldGoalTopicLayoutConvertsInPlace() throws {
        let root = tempDir("engelbart-legacy-")
        let legacy = try Home.ensureHome(root)
        let lctx = StoreContext(homeDir: root, root: legacy.root, dataRoot: legacy.root, libraryDb: try LibraryDB.open(root: legacy.root))
        let dir = Paths.join(legacy.root, "engelbart")
        let pid = "21f92f4d-0358-4154-850a-751be41113db", ui = "712e0e1d-0715-49f8-b47f-ed08b8cb3c9b", other = "69ee72b1-7963-4f83-8a7b-05d4a9e61d24"
        write(Paths.join(dir, "project.json"), #"{"id":"\#(pid)","name":"Engelbart","created":"2026-09-17T03:46:45.017Z"}"#)
        write(Paths.join(dir, "First steps", "meta.json"), #"{"id":"cc48c423-574b-4bff-85f6-53b2bc44b5ac","box":"current","created":"2026-09-17T03:46:45.503Z"}"#)
        write(Paths.join(dir, "First steps", "future.md"), "- later\n")
        let held = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]
        write(Paths.join(dir, "First steps", "User Interface", "meta.json"), #"{"id":"\#(ui)","status":"open","context":[{"id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","name":"Reading","children":["\#(held[0])"]},"\#(held[1])"],"created":"2026-09-17T03:47:32.035Z"}"#)
        write(Paths.join(dir, "First steps", "User Interface", "workspace.md"), "ui notes\n")
        write(Paths.join(dir, "Second", "meta.json"), #"{"id":"dd48c423-574b-4bff-85f6-53b2bc44b5ac","box":"past","created":"2026-09-17T04:00:00.000Z"}"#)
        write(Paths.join(dir, "Second", "User Interface", "meta.json"), #"{"id":"\#(other)","status":"done","context":[],"created":"2026-09-17T04:01:00.000Z"}"#)
        write(Paths.join(dir, "Second", "User Interface", "workspace.md"), "same name, other goal\n")
        let preview = try Migrate.migrateProjectDir(dir, dryRun: true)!
        XCTAssertEqual(preview.moved.map(\.to), ["User Interface", "User Interface 2"])
        XCTAssertTrue(exists(Paths.join(dir, "First steps", "User Interface", "workspace.md")), "a dry run moves nothing")
        let tree = try Projects.loadProject(lctx, pid)
        XCTAssertEqual(tree.workspaces.map { [$0.id, $0.name] }, [[ui, "User Interface"], [other, "User Interface 2"]])
        XCTAssertEqual(try Documents.readDoc(lctx, pid, .workspace(workspaceId: ui)), "ui notes\n")
        XCTAssertEqual(tree.workspaces[0].context, held)
        XCTAssertEqual(json(Paths.join(dir, "User Interface", "meta.json"))?["context"], .array(held.map { .string($0) }))
        XCTAssertEqual(read(Paths.join(dir, ".legacy", "First steps", "future.md")), "- later\n")
        let backups = try FileManager.default.contentsOfDirectory(atPath: Paths.join(legacy.root, ".backups")).filter { $0.hasPrefix("engelbart-") }
        XCTAssertEqual(backups.count, 1)
        XCTAssertEqual(read(Paths.join(legacy.root, ".backups", backups[0], "First steps", "User Interface", "workspace.md")), "ui notes\n")
        XCTAssertNil(try Migrate.migrateProjectDir(dir))
        XCTAssertEqual(try Projects.listProjects(lctx).count, 1, "dot directories are not projects")
    }

    func testLastOpenViewsStage() throws {
        let project = try Projects.create(ctx, "Reopen")
        let written = try AppState.writeLastOpen(ctx.dataRoot, ["projectId": .string(project.id), "workspaceId": "nope", "extra": 1])
        XCTAssertEqual(written, .init(projectId: project.id, workspaceId: nil))
        XCTAssertEqual(AppState.readLastOpen(ctx.dataRoot), written)
        write(Paths.join(ctx.dataRoot, "state.json"), #"{"projectId":"\#(project.id)","goalId":"\#(project.id)","topicId":"\#(project.id)"}"#)
        XCTAssertEqual(AppState.readLastOpen(ctx.dataRoot), .init(projectId: project.id, workspaceId: project.id))

        let other = try Projects.create(ctx, "Views elsewhere")
        let ws = "11111111-1111-4111-8111-111111111111", ws2 = "22222222-2222-4222-8222-222222222222"
        let note = "33333333-3333-4333-8333-333333333333", gone = "44444444-4444-4444-8444-444444444444"
        try AppState.writeLastOpen(ctx.dataRoot, ["projectId": .string(project.id), "workspaceId": .string(ws)])
        let saved = try AppState.writeView(ctx.dataRoot, project.id, ws, [
            "active": .string(note),
            "tabs": [["id": .string(note), "title": "Middle Canvas"], ["id": .string(note), "title": "twice"], ["id": "not-an-id", "title": "x"]],
            "positions": [.init("ws:\(ws)"): ["top": 120.4, "line": 7, "offset": 12.6, "hash": "abc12"], .init("note:\(note)"): ["top": 900], "bad:key": ["top": 1], .init("note:\(gone)"): ["top": "x"]],
            "extra": true,
        ])
        XCTAssertEqual(saved, ["active": .string(note), "tabs": [["id": .string(note), "title": "Middle Canvas"]], "positions": [.init("ws:\(ws)"): ["top": 120, "line": 7, "offset": 13, "hash": "abc12"], .init("note:\(note)"): ["top": 900]]])
        try AppState.writeView(ctx.dataRoot, project.id, ws2, ["active": .string(gone), "tabs": []])
        try AppState.writeView(ctx.dataRoot, other.id, ws, ["active": "ws", "tabs": [], "positions": [:]])
        let views = AppState.readViews(ctx.dataRoot, project.id)
        XCTAssertEqual(views[ws], saved)
        XCTAssertEqual(views[ws2], ["active": "ws", "tabs": [], "positions": [:]])
        XCTAssertEqual(Array(AppState.readViews(ctx.dataRoot, other.id).keys), [ws])
        XCTAssertEqual(AppState.readLastOpen(ctx.dataRoot), .init(projectId: project.id, workspaceId: ws), "saving a view keeps where the app reopens")
        XCTAssertEqual(AppState.readViews(ctx.dataRoot, "nope"), [:])
        XCTAssertThrowsMatchingSync({ try AppState.writeView(ctx.dataRoot, project.id, "nope", [:]) }, "workspace id")
        XCTAssertThrowsMatchingSync({ try AppState.writeView(ctx.dataRoot, project.id, ws, nil) }, "invalid")
        let withWs = try AppState.writeView(ctx.dataRoot, project.id, ws, ["active": .string(ws2), "tabs": [["id": .string(note), "title": "n", "kind": "note?"], ["id": .string(ws2), "title": "Child", "kind": "workspace"]], "positions": [:]])
        XCTAssertEqual(withWs["tabs"], [["id": .string(note), "title": "n"], ["id": .string(ws2), "title": "Child", "kind": "workspace"]])
        XCTAssertEqual(withWs["active"]?.string, ws2)
    }

    func testCleanStage() {
        let row = "55555555-5555-4555-8555-555555555555", other = "66666666-6666-4666-8666-666666666666"
        XCTAssertNil(AppState.cleanStage(nil)); XCTAssertNil(AppState.cleanStage([]))
        XCTAssertEqual(AppState.cleanStage([:]), ["active": 0, "tabs": []])
        let clean = AppState.cleanStage([
            "active": 6,
            "tabs": [
                ["item": .string(row), "title": "ColBERT"], ["item": "not-an-id", "title": "x"], ["address": "about:blank", "title": "blank"], ["address": "ABOUT:srcdoc"],
                ["address": .string(String(repeating: "x", count: 10))], ["address": .string("https://example.org/" + String(repeating: "a", count: 2048))],
                ["address": "http://www.example.org/a/", "title": "Example"], ["address": "https://example.org/a#top", "title": "the same page"],
                ["item": .string(row), "title": "twice"], ["address": "/Users/h/notes.md", "title": "notes.md"], ["address": "file:///Users/h/notes.md", "title": "the same file"],
                ["address": "javascript:alert(1)"], ["address": 42], .null, "https://example.org",
                ["address": "  https://other.org/p  ", "title": .string(String(repeating: "T", count: 300)), "extra": true], ["item": .string(other), "address": "https://ignored.org"],
            ],
        ])!
        XCTAssertEqual(clean["tabs"], [
            ["item": .string(row), "title": "ColBERT"], ["address": "http://www.example.org/a/", "title": "Example"], ["address": "/Users/h/notes.md", "title": "notes.md"],
            ["address": "https://other.org/p", "title": .string(String(repeating: "T", count: 200))], ["item": .string(other), "title": ""],
        ])
        XCTAssertEqual(clean["active"], 1)
        XCTAssertEqual(AppState.cleanStage(["active": 7, "tabs": clean["tabs"]!])?["active"], 4)
        XCTAssertEqual(AppState.cleanStage(["active": 1, "tabs": [["address": "https://a.org"], ["address": "https://a.org/"]]])?["active"], 0)
        XCTAssertEqual(AppState.cleanStage(["active": -3, "tabs": [["address": "https://a.org"]]])?["active"], 0)
        XCTAssertEqual(AppState.cleanStage(["active": "2", "tabs": [["address": "https://a.org"]]])?["active"], 0)
        XCTAssertEqual(AppState.cleanStage(["active": 2, "tabs": []]), ["active": 0, "tabs": []])
        let many = JSONValue.array((0..<20).map { ["address": .string("https://s\($0).org"), "title": .string("s\($0)")] })
        let capped = AppState.cleanStage(["active": 18, "tabs": many])!
        XCTAssertEqual(capped["tabs"]?.array?.count, 15); XCTAssertEqual(capped["active"], 14)
    }

    func testStageWindowsRecentKeptTogether() throws {
        let project = try Projects.create(ctx, "Stage kept")
        let other = try Projects.create(ctx, "Stage elsewhere")
        let ws = try Workspaces.create(ctx, project.id, name: "Plans")
        try AppState.writeLastOpen(ctx.dataRoot, ["projectId": .string(project.id), "workspaceId": .string(ws.id)])
        let view = try AppState.writeView(ctx.dataRoot, project.id, ws.id, ["active": "ws", "tabs": [], "positions": [:]])
        let windows = try AppState.writeWindows(ctx.dataRoot, [["projectId": .string(project.id), "workspaceId": .string(ws.id), "bounds": ["x": 0, "y": 0, "width": 800, "height": 600]]])
        try AppState.recordEdit(ctx, project.id, ws.id)
        let recent = AppState.read(ctx.dataRoot)["recent"]
        XCTAssertEqual(AppState.readStage(ctx.dataRoot, project.id), ["active": 0, "tabs": []])
        let saved = try AppState.writeStage(ctx.dataRoot, project.id, ["active": 1, "tabs": [["address": "https://example.org", "title": "Example"], ["address": "/Users/h/a.pdf", "title": "a"]]])
        try AppState.writeStage(ctx.dataRoot, other.id, ["active": 0, "tabs": [["address": "https://other.org", "title": "Other"]]])
        XCTAssertEqual(AppState.readStage(ctx.dataRoot, project.id), saved)
        let state = AppState.read(ctx.dataRoot)
        XCTAssertEqual(state["views"]?[project.id]?[ws.id], view)
        XCTAssertEqual(state["windows"], .array(windows)); XCTAssertEqual(state["recent"], recent)
        XCTAssertEqual([state["projectId"], state["workspaceId"]], [.string(project.id), .string(ws.id)])
        XCTAssertThrowsMatchingSync({ try AppState.writeStage(ctx.dataRoot, "nope", ["tabs": []]) }, "project id")
        XCTAssertThrowsMatchingSync({ try AppState.writeStage(ctx.dataRoot, project.id, nil) }, "invalid")
    }

    func testWhereToNextRecentAndAgents() throws {
        let project = try Projects.create(ctx, "Next place")
        let a = try Workspaces.create(ctx, project.id, name: "Alpha")
        let b = try Workspaces.create(ctx, project.id, name: "Beta")
        let c = try Workspaces.create(ctx, project.id, name: "Gamma", parentId: b.id)
        let d = try Workspaces.create(ctx, project.id, name: "Delta")
        for w in [a, b, c, a, d] { try AppState.recordEdit(ctx, project.id, w.id) }
        var nav = AppState.readNav(ctx)
        XCTAssertEqual(nav["recent"]?.array?.map { $0["name"]!.string! }, ["Delta", "Alpha", "Gamma", "Beta"])
        XCTAssertEqual(nav["recent"]?[2]?["path"], "Beta/Gamma"); XCTAssertEqual(nav["recent"]?[2]?["projectName"], "Next place")
        XCTAssertThrowsMatchingSync({ try AppState.recordEdit(ctx, project.id, "99999999-9999-4999-8999-999999999999") }, "Unknown workspace")
        try AppState.agentStarted(ctx.dataRoot, id: "ask-1", kind: "bart", projectId: project.id, workspaceId: b.id, doc: ["kind": "workspace", "workspaceId": .string(b.id)])
        try AppState.agentStarted(ctx.dataRoot, id: "ask-2", kind: "bart", projectId: project.id, workspaceId: c.id, doc: ["kind": "note", "id": "not-an-id"])
        nav = AppState.readNav(ctx)
        XCTAssertEqual(nav["agents"]?.array?.map { "\($0["id"]!.string!) \($0["status"]!.string!) \($0["name"]!.string!)" }, ["ask-1 running Beta", "ask-2 running Gamma"])
        XCTAssertEqual(nav["agents"]?[1]?["doc"], .null)
        try AppState.agentFinished(ctx.dataRoot, "ask-1")
        try AppState.agentStopped(ctx.dataRoot, "ask-2")
        nav = AppState.readNav(ctx)
        XCTAssertEqual(nav["agents"]?.array?.map { "\($0["id"]!.string!) \($0["status"]!.string!)" }, ["ask-1 waiting"])
        XCTAssertNotNil(nav["agents"]?[0]?["finished"]?.string)
        XCTAssertEqual(try AppState.seenAgents(ctx.dataRoot, project.id, a.id), 0)
        XCTAssertEqual(try AppState.seenAgents(ctx.dataRoot, project.id, b.id), 1)
        XCTAssertEqual(AppState.readNav(ctx)["agents"], [])
        let file = Paths.join(ctx.dataRoot, "state.json")
        let state = json(file)!
        write(file, state.merging(["agents": [
            ["id": "old-run", "kind": "bart", "projectId": .string(project.id), "workspaceId": .string(a.id), "status": "running", "started": "2026-09-21T10:00:00.000Z"],
            ["id": "gone", "kind": "bart", "projectId": .string(project.id), "workspaceId": "99999999-9999-4999-8999-999999999999", "status": "waiting", "finished": "2026-09-21T10:00:00.000Z"],
            ["id": "kept", "kind": "bart", "projectId": .string(project.id), "workspaceId": .string(d.id), "status": "waiting", "finished": "2026-09-21T10:00:00.000Z"],
            ["id": "odd", "kind": "robot", "projectId": .string(project.id), "workspaceId": .string(d.id), "status": "waiting"], "nonsense",
        ]]).text())
        XCTAssertEqual(AppState.readNav(ctx)["agents"]?.array?.map { $0["id"]!.string! }, ["kept"])
        func old(_ minutes: Double) -> JSONValue { .string(Time.iso(Date().addingTimeInterval(-minutes * 60))) }
        write(file, state.merging(["agents": [], "recent": [
            ["projectId": .string(project.id), "workspaceId": .string(d.id), "at": old(5)], ["projectId": .string(project.id), "workspaceId": .string(a.id), "at": old(40)],
            ["projectId": .string(project.id), "workspaceId": .string(c.id), "at": old(50)], ["projectId": .string(project.id), "workspaceId": .string(b.id), "at": old(60)],
        ]]).text())
        XCTAssertEqual(AppState.readNav(ctx)["recent"]?.array?.map { $0["name"]!.string! }, ["Delta", "Alpha", "Gamma"])
        write(file, state.merging(["agents": [], "recent": [
            ["projectId": .string(project.id), "workspaceId": .string(d.id), "at": old(1)], ["projectId": .string(project.id), "workspaceId": .string(a.id), "at": old(2)],
            ["projectId": .string(project.id), "workspaceId": .string(c.id), "at": old(3)], ["projectId": .string(project.id), "workspaceId": .string(b.id), "at": old(29)],
        ]]).text())
        XCTAssertEqual(AppState.readNav(ctx)["recent"]?.array?.count, 4)
        try AppState.recordEdit(ctx, project.id, a.id)
        XCTAssertEqual(AppState.readNav(ctx)["recent"]?.array?.map { $0["name"]!.string! }, ["Alpha", "Delta", "Gamma", "Beta"])
    }

    func testStarredAndFolders() throws {
        let project = try Projects.create(ctx, "Stars"), other = try Projects.create(ctx, "Other stars")
        let (a, b, c) = ("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333")
        XCTAssertEqual(AppState.readStarred(ctx.dataRoot, project.id), [])
        try AppState.setStarred(ctx.dataRoot, project.id, a, true)
        try AppState.setStarred(ctx.dataRoot, project.id, b, true)
        XCTAssertEqual(try AppState.setStarred(ctx.dataRoot, project.id, a, true), [b, a])
        try AppState.setStarred(ctx.dataRoot, other.id, c, true)
        XCTAssertEqual(try AppState.setStarred(ctx.dataRoot, project.id, b, false), [a])
        XCTAssertEqual(AppState.readStarred(ctx.dataRoot, other.id), [c])
        XCTAssertThrowsMatchingSync({ try AppState.setStarred(ctx.dataRoot, project.id, "not-an-id", true) }, "library id")
        let state = AppState.read(ctx.dataRoot)
        write(Paths.join(ctx.dataRoot, "state.json"), JSONValue.object(state).merging(["starred": [.init(project.id): [.string(a), "junk", .string(a), 7, .string(b)]]]).text())
        XCTAssertEqual(AppState.readStarred(ctx.dataRoot, project.id), [a, b])

        let folder = try AppState.createFolder(ctx.dataRoot, "  References  ").folder
        XCTAssertEqual(folder.name, "References")
        try AppState.createFolder(ctx.dataRoot, "Reading")
        try AppState.addToFolder(ctx.dataRoot, folder.id, [a, b, a])
        var held = AppState.readFolders(ctx.dataRoot)
        XCTAssertEqual(held.map(\.name), ["References", "Reading"]); XCTAssertEqual(held[0].items, [a, b])
        try AppState.removeFromFolder(ctx.dataRoot, folder.id, a)
        try AppState.renameFolder(ctx.dataRoot, folder.id, "Refs")
        held = AppState.readFolders(ctx.dataRoot)
        XCTAssertEqual(held[0].name, "Refs"); XCTAssertEqual(held[0].items, [b])
        XCTAssertThrowsMatchingSync({ try AppState.createFolder(ctx.dataRoot, "   ") }, "needs a name")
        XCTAssertThrowsMatchingSync({ try AppState.addToFolder(ctx.dataRoot, "33333333-3333-4333-8333-333333333333", [a]) }, "Unknown folder")
        try AppState.deleteFolder(ctx.dataRoot, folder.id)
        XCTAssertEqual(AppState.readFolders(ctx.dataRoot).map(\.name), ["Reading"])
        XCTAssertNotNil(AppState.read(ctx.dataRoot)["folders"]?.array)
    }

    func testTreeEditedTimes() throws {
        let project = try Projects.create(ctx, "Edited")
        let top = try Workspaces.create(ctx, project.id, name: "Top")
        let child = try Workspaces.create(ctx, project.id, name: "Child", parentId: top.id)
        let before = try Projects.loadProject(ctx, project.id).workspaces[0]
        XCTAssertNotNil(before.edited.flatMap(Time.parse)); XCTAssertNotNil(before.children[0].edited.flatMap(Time.parse))
        let later = Date().addingTimeInterval(60)
        try FileManager.default.setAttributes([.modificationDate: later], ofItemAtPath: Paths.join(project.dir, "Top", "Child", "workspace.md"))
        let after = try Projects.loadProject(ctx, project.id).workspaces[0]
        XCTAssertEqual(after.children[0].id, child.id)
        XCTAssertEqual(Time.parse(after.children[0].edited!)!.timeIntervalSince1970.rounded(), later.timeIntervalSince1970.rounded())
    }

    func testReadTextFileAndResolvePageFile() throws {
        let project = try Projects.create(ctx, "Browser")
        write(Paths.join(project.dir, "notes.txt"), "hello\nworld\n")
        XCTAssertEqual(try Documents.readProjectTextFile(ctx, project.id, "notes.txt").text, "hello\nworld\n")
        XCTAssertEqual(try Documents.readProjectTextFile(ctx, project.id, "./notes.txt").kind, "file")
        XCTAssertEqual(try Documents.readProjectTextFile(ctx, project.id, "~/" + Paths.relative(home, Paths.join(project.dir, "notes.txt"))).text, "hello\nworld\n")
        let dir = try Documents.readProjectTextFile(ctx, project.id, project.dir)
        XCTAssertEqual(dir.kind, "directory"); XCTAssertTrue(dir.text.components(separatedBy: "\n").contains("notes.txt"))
        XCTAssertThrowsMatchingSync({ try Documents.readProjectTextFile(ctx, project.id, "/etc/hosts") }, "inside your home directory")
        XCTAssertThrowsError(try Documents.readProjectTextFile(ctx, project.id, "missing.txt"))
        write(Paths.join(project.dir, "big.txt"), String(repeating: "x", count: 25000))
        let big = try Documents.readProjectTextFile(ctx, project.id, "big.txt")
        XCTAssertEqual(big.text.count, 20000); XCTAssertTrue(big.truncated)

        let code = Paths.join(home, "code-pages")
        write(Paths.join(code, "docs", "index.htm"), "<h1>d</h1>")
        let pages = try Projects.createProject(ctx, .init(name: "Pages", directory: code))
        write(Paths.join(pages.dir, "My Workspace", "report.html"), "<h1>r</h1>")
        write(Paths.join(pages.dir, "notes.txt"), "text")
        let report = try Paths.real(Paths.join(pages.dir, "My Workspace", "report.html"))
        XCTAssertEqual(try Documents.resolvePageFile(ctx, pages.id, "My Workspace/report.html"), .init(path: report, url: Paths.fileURL(report)))
        XCTAssertEqual(try Documents.resolvePageFile(ctx, pages.id, report)?.path, report)
        XCTAssertEqual(try Documents.resolvePageFile(ctx, pages.id, "~/" + Paths.relative(home, report))?.path, report)
        XCTAssertEqual(try Documents.resolvePageFile(ctx, pages.id, Paths.fileURL(report))?.path, report)
        XCTAssertEqual(try Documents.resolvePageFile(ctx, pages.id, "\(Paths.basename(pages.dir))/My Workspace/report.html")?.path, report)
        XCTAssertEqual(try Documents.resolvePageFile(ctx, pages.id, "docs/index.htm")?.path, try Paths.real(Paths.join(code, "docs", "index.htm")))
        XCTAssertEqual(try Documents.resolvePageFile(ctx, pages.id, "My Workspace/report.html#results?x")?.url, Paths.fileURL(report) + "#results?x")
        write(Paths.join(pages.dir, "My Workspace", "paper.pdf"), "%PDF-1.4")
        XCTAssertNotNil(try Documents.resolvePageFile(ctx, pages.id, "My Workspace/paper.pdf"))
        for not in ["notes.txt", "missing.html", "apple.com", "example.com/index.html", "/etc/hosts", "My Workspace"] {
            XCTAssertNil(try Documents.resolvePageFile(ctx, pages.id, not), not)
        }
        try FileManager.default.createSymbolicLink(atPath: Paths.join(pages.dir, "escape.html"), withDestinationPath: "/etc/hosts")
        XCTAssertNil(try Documents.resolvePageFile(ctx, pages.id, "escape.html"))
    }

    func testANoteOfAnotherProjectSavesInItsOwn() throws {
        let mine = try Projects.create(ctx, "Mentions here"), theirs = try Projects.create(ctx, "Notes there")
        let note = try Documents.createNote(ctx, theirs.id, name: "Over there", text: "first\n")
        XCTAssertEqual(try Documents.readDoc(ctx, mine.id, .note(id: note.id)), "first\n")
        try Documents.writeDoc(ctx, mine.id, .note(id: note.id), "edited here\n")
        XCTAssertEqual(read(Paths.join(theirs.dir, "Over there.md")), "edited here\n")
        XCTAssertFalse(exists(Paths.join(mine.dir, "Over there.md")))
        XCTAssertEqual(try Documents.renameNote(ctx, mine.id, note.id, "Renamed there").name, "Renamed there")
        XCTAssertTrue(exists(Paths.join(theirs.dir, "Renamed there.md")))
        XCTAssertThrowsMatchingSync({ try Documents.readDoc(ctx, mine.id, .note(id: "00000000-0000-4000-8000-000000000000")) }, "Unknown note")
        XCTAssertNil(try Documents.writeDoc(ctx, theirs.id, .note(id: note.id), "edited here\n"), "a save that changes nothing is not an edit")
        XCTAssertEqual(try ctx.libraryDb.get(note.id)?.charCount, 12)
    }

    func testWindowsKeptAndPlacement() throws {
        let dataRoot = tempDir("eb-windows-state-")
        let project = "11111111-2222-4333-8444-555555555555", workspace = "66666666-7777-4888-8999-000000000000"
        try AppState.writeLastOpen(dataRoot, ["projectId": .string(project), "workspaceId": .string(workspace)])
        XCTAssertEqual(AppState.readWindows(dataRoot), [])
        let saved = try AppState.writeWindows(dataRoot, [
            ["projectId": .string(project), "workspaceId": .string(workspace), "bounds": ["x": 10.4, "y": 20, "width": 1200, "height": 800]],
            ["projectId": .null, "workspaceId": .string(workspace), "bounds": ["x": 0, "y": 0, "width": "wide", "height": 800]], "nonsense",
        ])
        XCTAssertEqual(saved, [["projectId": .string(project), "workspaceId": .string(workspace), "bounds": ["x": 10, "y": 20, "width": 1200, "height": 800]], ["projectId": .null, "workspaceId": .null, "bounds": .null]])
        XCTAssertEqual(AppState.readWindows(dataRoot), saved)
        XCTAssertEqual(AppState.readLastOpen(dataRoot), .init(projectId: project, workspaceId: workspace))
        typealias R = WindowPlaces.Rect
        let screen = [R(x: 0, y: 0, width: 1440, height: 900)]
        XCTAssertEqual(WindowPlaces.placement(bounds: R(x: 100, y: 50, width: 1000, height: 700), workAreas: screen), R(x: 100, y: 50, width: 1000, height: 700))
        XCTAssertEqual(WindowPlaces.placement(bounds: R(x: 4000, y: 50, width: 1000, height: 700), workAreas: screen), R(width: 1000, height: 700))
        XCTAssertEqual(WindowPlaces.placement(bounds: R(x: 0, y: 0, width: 300, height: 200), workAreas: screen), R(x: 0, y: 0, width: 900, height: 560))
        XCTAssertEqual(WindowPlaces.placement(from: R(x: 40, y: 40, width: 1200, height: 800), workAreas: screen), R(x: 64, y: 64, width: 1200, height: 800))
        XCTAssertEqual(WindowPlaces.placement(workAreas: screen), R(width: 1440, height: 900))
        XCTAssertTrue(WindowPlaces.cleanPlace(["projectId": "not an id", "workspaceId": "x"]) == (nil, nil))
    }

    func testCountsRecountAndCards() throws {
        let project = try Projects.create(ctx, "Counts")
        let workspace = try Workspaces.create(ctx, project.id, name: "Draft")
        XCTAssertEqual(workspace.chars, 0)
        try Documents.writeDoc(ctx, project.id, .workspace(workspaceId: workspace.id), "twelve chars")
        let dir = try Workspaces.find(ctx, project.id, workspace.id).workspace.dir
        XCTAssertEqual(json(Paths.join(dir, "meta.json"))?["chars"], 12)
        var legacy = json(Paths.join(dir, "meta.json"))!.object!; legacy["chars"] = nil
        write(Paths.join(dir, "meta.json"), JSONValue.object(legacy).text())
        XCTAssertEqual(try Projects.loadProject(ctx, project.id).workspaces[0].chars, 12)
        XCTAssertEqual(Workspaces.recount(ctx), 0)
        XCTAssertNil(json(Paths.join(dir, "meta.json"))?["chars"])
        try Documents.writeDoc(ctx, project.id, .workspace(workspaceId: workspace.id), "abc")
        write(Paths.join(dir, "workspace.md"), "written outside")
        XCTAssertEqual(Workspaces.recount(ctx), 1)
        XCTAssertEqual(json(Paths.join(dir, "meta.json"))?["chars"], 15)

        let cards = try Projects.create(ctx, "Cards")
        var made: [PublicWorkspace] = []
        for name in ["One", "Two", "Three", "Four", "Five"] { made.append(try Workspaces.create(ctx, cards.id, name: name)) }
        for (index, w) in made.enumerated() {
            try Documents.writeDoc(ctx, cards.id, .workspace(workspaceId: w.id), "**\(w.name)** body")
            let file = Paths.join(try Workspaces.find(ctx, cards.id, w.id).workspace.dir, "workspace.md")
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1_767_225_600 + Double(index) * 86400)], ofItemAtPath: file)
        }
        let note = try Documents.createNote(ctx, cards.id, name: "Card note")
        let card = try Projects.listProjects(ctx).first { $0.id == cards.id }!
        XCTAssertEqual(card.workspaceCount, 5)
        XCTAssertEqual(card.recent?.map(\.name), ["Five", "Four", "Three", "Two"])
        XCTAssertEqual(card.recent?[0].text, "**Five** body"); XCTAssertEqual(card.recent?[0].chars, 13)
        XCTAssertEqual(card.libraryIds, [note.id])
        let reserved = try Projects.createProjectWithWelcome(ctx, .init(name: "test"))
        XCTAssertEqual(reserved.project.slug, "test-project")
        XCTAssertEqual(try Projects.renameProject(ctx, try Projects.create(ctx, "Seedling").id, "seed").slug, "seed-project")
    }

    func testDefaultTarget() throws {
        let project = try Projects.create(ctx, "Default repo")
        XCTAssertEqual(try Projects.setDefaultTarget(ctx, project.id, ["kind": "project"]), ["kind": "project"])
        let id = uuid()
        XCTAssertEqual(try Projects.setDefaultTarget(ctx, project.id, ["kind": "library", "id": .string(id)]), ["kind": "library", "id": .string(id)])
        XCTAssertEqual(try Projects.find(ctx, project.id).defaultTarget, ["kind": "library", "id": .string(id)])
        XCTAssertThrowsMatchingSync({ try Projects.setDefaultTarget(ctx, project.id, ["kind": "elsewhere"]) }, "the default repo must be")
    }
}

/// A mutable box a @Sendable closure can write to in a test.
final class Box<T>: @unchecked Sendable { var value: T; init(_ value: T) { self.value = value } }
