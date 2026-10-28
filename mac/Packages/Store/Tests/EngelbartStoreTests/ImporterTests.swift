import XCTest
import EngelbartCore
@testable import EngelbartStore

/// The importer, end to end against scratch PGlite databases made in a temp dir with `node` + a checkout's node_modules
/// (skipped where there is no such runtime). Never touches ~/.engelbart.
final class ImporterTests: XCTestCase {
    override func tearDown() { SQLiteRegistry.closeAll() }

    static let makeScript = #"""
    'use strict';
    const { PGlite } = require('@electric-sql/pglite');
    (async () => {
      const [libraryDir, notesDir, oldDir] = process.argv.slice(2);
      const lib = new PGlite(libraryDir); await lib.waitReady;
      await lib.exec(`create table library (id uuid primary key, name text not null, type text not null, path text, url text, folder_path text, project_id uuid,
        created timestamptz not null default now(), last_edited timestamptz not null default now(), summary text, summary_edited timestamptz, char_count integer,
        github_id text, tags text[] not null default '{}', categorized integer, source text, category text, item_date text, origin_url text, place text,
        messages integer, minutes integer, titled integer);
        create table library_text (library_id uuid primary key, text text not null, file_mtime double precision not null, extracted_at timestamptz not null default now());
        create table sandbox_runs (id uuid primary key, library_id uuid not null, status text not null default 'starting', build_log jsonb not null default '[]', build_milestones jsonb, port integer, created_at timestamptz not null default now(), updated_at timestamptz not null default now());`);
      await lib.query("insert into library (id, name, type, path, tags, categorized, created, last_edited, summary) values ('11111111-1111-4111-8111-111111111111', 'A note', 'md', '/p/A note.md', array['note'], 1, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', 'About it')");
      await lib.query("insert into library (id, name, type, url, tags, categorized) values ('22222222-2222-4222-8222-222222222222', 'o/r', 'website', 'https://github.com/o/r', array['git'], 1)");
      await lib.query("insert into library_text (library_id, text, file_mtime) values ('11111111-1111-4111-8111-111111111111', 'body', 12.5)");
      await lib.query(`insert into sandbox_runs (id, library_id, status, build_log, port) values ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'stopped', '[{"message":"Creating sandbox"}]', 3000)`);
      await lib.close();
      const notes = new PGlite(notesDir); await notes.waitReady;
      await notes.exec(`create table notes (id uuid primary key, name text not null, path text not null, goal_id uuid, topic_id uuid, created timestamptz not null default now(), last_edited timestamptz not null default now());
        create table post_its (id uuid primary key, text text not null default '', nx double precision not null, ny double precision not null, width double precision not null, height double precision not null, z double precision not null default 0, created timestamptz not null default now(), last_edited timestamptz not null default now(), deleted timestamptz);`);
      await notes.query("insert into notes (id, name, path, topic_id) values ('11111111-1111-4111-8111-111111111111', 'A note', 'A note.md', '44444444-4444-4444-8444-444444444444')");
      await notes.query("insert into post_its (id, text, nx, ny, width, height, z) values ('55555555-5555-4555-8555-555555555555', 'stick', 0.5, 0.25, 220, 160, 2)");
      await notes.close();
      const old = new PGlite(oldDir); await old.waitReady;
      await old.exec(`create table library (id uuid primary key, name text not null, type text not null, path text, url text, folder_path text, project_id uuid, created timestamptz not null default now(), last_edited timestamptz not null default now());`);
      await old.query("insert into library (id, name, type, url) values ('66666666-6666-4666-8666-666666666666', 'arXiv 1706.03762', 'paper', 'https://arxiv.org/abs/1706.03762')");
      await old.close();
    })().catch((e) => { console.error(e); process.exit(1); });
    """#

    func testImportsAnElectronRootIntoSQLite() async throws {
        guard let runtime = StoreImporter.nodeRuntime() else { throw XCTSkip("no node with @electric-sql/pglite here") }
        let scratch = tempDir("engelbart-import-src-")
        let electron = Paths.join(scratch, ".engelbart")
        let project = Paths.join(electron, "thesis")
        write(Paths.join(electron, "config.json"), #"{"testMode":false}"#)
        write(Paths.join(electron, "state.json"), #"{"projectId":"77777777-7777-4777-8777-777777777777"}"#)
        write(Paths.join(project, "project.json"), #"{"id":"77777777-7777-4777-8777-777777777777","name":"Thesis"}"#)
        write(Paths.join(project, "A note.md"), "hello\n")
        let script = Paths.join(scratch, "make.cjs")
        write(script, Self.makeScript)
        let made = try await ProcessRunner.run(runtime.executable, [script, Paths.join(electron, "library.pglite"), Paths.join(project, "notes.pglite"), Paths.join(scratch, "old", "library.pglite")], environment: runtime.environment, timeout: 300)
        XCTAssertTrue(made.exit.succeeded, made.stderr)

        let target = Paths.join(tempDir("engelbart-import-dst-"), ".engelbart-swift")
        let report = try await StoreImporter.importElectronRoot(from: URL(fileURLWithPath: electron), to: URL(fileURLWithPath: target), runtime: runtime)
        XCTAssertEqual(read(Paths.join(target, "thesis", "A note.md")), "hello\n")
        XCTAssertEqual(json(Paths.join(target, "state.json"))?["projectId"], "77777777-7777-4777-8777-777777777777")
        XCTAssertFalse(exists(Paths.join(target, "library.pglite")), "no PGlite directory is copied")
        XCTAssertEqual(report.databases.count, 2)

        let library = try LibraryDB.open(root: target)
        let note = try library.get("11111111-1111-4111-8111-111111111111")!
        XCTAssertEqual([note.name, note.type, note.summary, note.created, note.lastEdited], ["A note", "md", "About it", "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"])
        XCTAssertEqual(note.tags, ["note"]); XCTAssertEqual(note.categorized, 1)
        XCTAssertEqual(try library.textsFor([note.id], max: 100), [note.id: "body"])
        XCTAssertEqual(try library.textStamps()[note.id], 12.5)
        let run = try library.query("select * from sandbox_runs")[0]
        XCTAssertEqual(run["port"]?.int, 3000)
        XCTAssertEqual(try JSONValue.parse(run["build_log"]!.string!), [["message": "Creating sandbox"]], "jsonb as JSON text")
        XCTAssertNotNil(try JSONValue.parse(run["build_milestones"]!.string!)["message:Creating sandbox"], "a run with no milestones is backfilled")

        let notes = try NotesDB.open(projectDir: Paths.join(target, "thesis"))
        XCTAssertEqual(try notes.list().map(\.topicId), ["44444444-4444-4444-8444-444444444444"])
        let card = try notes.postIts.list()[0]
        XCTAssertEqual([card.nx, card.ny, card.width, card.z], [0.5, 0.25, 220, 2]); XCTAssertEqual(card.text, "stick")

        // the Swift app reads it as its own
        let ctx = StoreContext(homeDir: scratch, root: target, dataRoot: target, libraryDb: library)
        XCTAssertEqual(try Projects.listProjects(ctx).map(\.name), ["Thesis"])
        XCTAssertEqual(try Projects.loadProject(ctx, "77777777-7777-4777-8777-777777777777").notes.map(\.name), ["A note"])

        await XCTAssertThrowsMatching({ try await StoreImporter.importElectronRoot(from: URL(fileURLWithPath: electron), to: URL(fileURLWithPath: target), runtime: runtime) }, "already has a library")

        // a library typed the old way is converted after its copy is set aside
        let oldTarget = tempDir("engelbart-import-old-")
        try await StoreImporter.importElectronRoot(from: URL(fileURLWithPath: Paths.join(scratch, "old")), to: URL(fileURLWithPath: oldTarget), runtime: runtime)
        let converted = try LibraryDB.open(root: oldTarget).get("66666666-6666-4666-8666-666666666666")!
        XCTAssertEqual(converted.type, "website"); XCTAssertEqual(converted.tags, ["paper"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: Paths.join(oldTarget, ".backups")).filter { $0.hasPrefix("library-") }.count, 1)
    }
}
