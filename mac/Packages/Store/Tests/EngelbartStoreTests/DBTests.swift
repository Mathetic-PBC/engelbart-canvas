import XCTest
import EngelbartCore
@testable import EngelbartStore

/// test/db.test.cjs
final class DBTests: XCTestCase {
    func testLibrarySchemaInsertTypeConstraintListOrder() throws {
        let root = tempDir("engelbart-db-")
        let library = try LibraryDB.open(root: root)
        let id = uuid()
        let row = try library.insert(NewLibraryRow(id: id, name: "A paper", type: "pdf", path: "/tmp/a.pdf"))
        XCTAssertEqual(row.id, id); XCTAssertEqual(row.type, "pdf"); XCTAssertNil(row.url)
        XCTAssertNotNil(row.created.range(of: #"^\d{4}-\d{2}-\d{2}T"#, options: .regularExpression))
        XCTAssertThrowsMatchingSync({ try library.insert(NewLibraryRow(name: "x", type: "chat")) }, "Unknown library type")
        for type in ["paper", "dataset", "git_repo", "note"] { XCTAssertThrowsMatchingSync({ try library.insert(NewLibraryRow(name: "x", type: type)) }, "Unknown library type") }
        try library.insert(NewLibraryRow(name: "Site", type: "website", url: "https://example.com"))
        let rows = try library.list()
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].name, "A paper")
        XCTAssertEqual(JSONValue.encode(rows[0]).object!.keys.sorted(), ["categorized", "category", "char_count", "created", "folder_path", "github_id", "id", "item_date", "last_edited", "messages", "minutes", "name", "origin_url", "path", "place", "project_id", "source", "summary", "summary_edited", "tags", "titled", "type", "url"])
        XCTAssertEqual(try library.query("select * from library limit 1")[0].keys.sorted(), LibraryRow.columns.sorted(), "the table has exactly these columns")
        XCTAssertNil(rows[0].source); XCTAssertNil(rows[0].category); XCTAssertNil(rows[0].titled)
        XCTAssertNil(rows[0].summary); XCTAssertNil(rows[0].summaryEdited); XCTAssertNil(rows[0].charCount)
        XCTAssertEqual(rows[0].tags, []); XCTAssertNil(rows[0].categorized)
    }

    func testTagsClosedSetNoteIsMdAndCategorizedVersion() throws {
        let library = try LibraryDB.open(root: tempDir("engelbart-db-"))
        XCTAssertEqual(LibraryVocabulary.tags, ["paper", "git", "note"])
        let link = try library.insert(NewLibraryRow(name: "arXiv 1706.03762", type: "website", tags: ["paper", "paper"], url: "https://arxiv.org/abs/1706.03762"))
        XCTAssertEqual(link.tags, ["paper"], "once each")
        XCTAssertThrowsMatchingSync({ try library.insert(NewLibraryRow(name: "x", type: "pdf", tags: ["website"])) }, "Unknown library tag")
        XCTAssertThrowsMatchingSync({ try library.insert(NewLibraryRow(name: "x", type: "pdf", tags: ["note"], path: "/tmp/x.pdf")) }, "(?i)only a note")
        XCTAssertThrowsMatchingSync({ try library.query("insert into library (id, name, type, tags, created, last_edited) values (?, 'x', 'pdf', '[\"note\"]', 'a', 'b')", [.text(uuid())]) }, "library_note_is_md")

        let pdf = try library.insert(NewLibraryRow(name: "Unread", type: "pdf", path: "/tmp/unread.pdf"))
        let settled = try library.insert(NewLibraryRow(name: "Settled", type: "csv", path: "/tmp/s.csv", categorized: 1))
        let note = try library.insert(NewLibraryRow(name: "A note", type: "md", tags: ["note"], path: "/tmp/n.md"))
        let image = try library.insert(NewLibraryRow(name: "Attachment 1", type: "image", path: "/tmp/1.png"))
        func behind(_ rules: Int) throws -> [String] { try library.uncategorized(rules).map(\.id) }
        XCTAssertEqual([try behind(1).contains(pdf.id), try behind(1).contains(settled.id), try behind(2).contains(settled.id)], [true, false, true])
        XCTAssertEqual(try library.settleUninferable(1), 2, "the note and the image")
        XCTAssertEqual(try library.get(note.id)?.categorized, 1); XCTAssertEqual(try library.get(image.id)?.categorized, 1)
        XCTAssertFalse(try behind(1).contains(note.id))

        try library.setSummary(pdf.id, "What it says.", at: Time.parse("2026-09-01T00:00:00.000Z")!)
        let before = try library.get(pdf.id)!
        let tagged = try library.setCategory(pdf.id, type: "pdf", tags: ["paper"], rules: 1)
        XCTAssertEqual(tagged.tags, ["paper"]); XCTAssertEqual(tagged.categorized, 1)
        XCTAssertEqual([tagged.lastEdited, tagged.summary, tagged.summaryEdited], [before.lastEdited, before.summary, before.summaryEdited], "categorizing is not an edit")
        XCTAssertFalse(try behind(1).contains(pdf.id))
        XCTAssertEqual(try library.setCategory(pdf.id, type: "pdf", tags: ["paper"], rules: nil).categorized, 1, "nil leaves the mark where it was")
        XCTAssertThrowsMatchingSync({ try library.setCategory(link.id, type: "website", tags: ["note"], rules: 1) }, "(?i)only a note")
        XCTAssertThrowsMatchingSync({ try library.setCategory(link.id, type: "paper", tags: [], rules: 1) }, "Unknown library type")
        XCTAssertThrowsMatchingSync({ try library.setCategory(uuid(), type: "pdf", tags: [], rules: 1) }, "Unknown library item")
    }

    func testRenameTouchRewritePathPrefix() throws {
        let library = try LibraryDB.open(root: tempDir("engelbart-db-"))
        let inside = uuid(), outside = uuid()
        try library.insert(NewLibraryRow(id: inside, name: "n", type: "md", tags: ["note"], path: "/root/Old Project/n.md", projectId: uuid()))
        try library.insert(NewLibraryRow(id: outside, name: "o", type: "md", tags: ["note"], path: "/root/Old Project 2/o.md"))
        XCTAssertEqual(try library.rename(inside, "renamed")?.name, "renamed")
        XCTAssertEqual(try library.rewritePathPrefix("/root/Old Project/", "/root/New Project/"), 1)
        XCTAssertEqual(try library.get(inside)?.path, "/root/New Project/n.md")
        XCTAssertEqual(try library.get(outside)?.path, "/root/Old Project 2/o.md")
        XCTAssertTrue(try library.touch(inside))
        XCTAssertTrue(try library.remove(outside))
        XCTAssertNil(try library.get(outside))
    }

    func testAboutChecksAndFillAbout() throws {
        let library = try LibraryDB.open(root: tempDir("engelbart-db-"))
        func insert(_ about: AboutFields) throws -> LibraryRow { try library.insert(NewLibraryRow(name: "x", type: "website", url: "https://example.org/\(uuid())", about: about)) }
        XCTAssertThrowsMatchingSync({ try insert(AboutFields(source: "Dropbox")) }, #"Unknown library source: Dropbox \(one of Obsidian, .*engelbart, mac, web, github, create\)"#)
        XCTAssertThrowsMatchingSync({ try insert(AboutFields(source: "GitHub")) }, "Unknown library source: GitHub")
        XCTAssertThrowsMatchingSync({ try insert(AboutFields(category: "kind")) }, "Unknown library category: kind")
        XCTAssertThrowsMatchingSync({ try insert(AboutFields(itemDate: "2026-13-01")) }, "YYYY or YYYY-MM-DD")
        XCTAssertThrowsMatchingSync({ try insert(AboutFields(originUrl: "javascript:alert(1)")) }, #"http\(s\)"#)
        XCTAssertThrowsMatchingSync({ try insert(AboutFields(messages: -1)) }, "non-negative integer")
        let row = try insert(AboutFields(itemDate: "2025", place: "  a   b  "))
        XCTAssertEqual(row.itemDate, "2025"); XCTAssertEqual(row.place, "a b")
        XCTAssertThrowsMatchingSync({ try library.fillAbout(row.id, AboutFields(source: "Somewhere")) }, "Unknown library source")
        let filled = try library.fillAbout(row.id, AboutFields(source: "web", place: "other"))
        XCTAssertEqual([filled.source, filled.place], ["web", "a b"], "only empty columns are filled")
        XCTAssertThrowsMatchingSync({ try library.insert(NewLibraryRow(name: "bad", type: "website", tags: ["git"], githubId: "12ab")) }, "(?i)github id")
        try library.insert(NewLibraryRow(name: "one", type: "website", tags: ["git"], url: "https://github.com/x/a", githubId: "101"))
        XCTAssertThrowsMatchingSync({ try library.insert(NewLibraryRow(name: "dup", type: "website", tags: ["git"], url: "https://github.com/x/dup", githubId: "101")) }, "(?i)unique|duplicate")
    }

    func testTextAdoptAndRepos() throws {
        let library = try LibraryDB.open(root: tempDir("engelbart-db-"))
        let page = try library.insert(NewLibraryRow(name: "p", type: "website", url: "https://e.org/a.pdf"))
        XCTAssertEqual(try library.adoptPdf(page.id, file: "/tmp/x.pdf")?.type, "pdf")
        XCTAssertNil(try library.adoptPdf(page.id, file: "/tmp/y.pdf"), "only a page with no file changes")
        try library.setText(page.id, "a\u{0}b" + String(repeating: "c", count: 20), mtime: 5)
        XCTAssertEqual(try library.textsFor([page.id], max: 4), [page.id: "abcc"])
        XCTAssertEqual(try library.textStamps()[page.id], 5)
        XCTAssertEqual(try library.textsFor([], max: 10), [:])
        let repo = try library.insert(NewLibraryRow(name: "o/r", type: "website", tags: ["git"], url: "https://github.com/o/r"))
        XCTAssertEqual(try library.updateRepo(repo.id, name: "o/r", url: "https://github.com/o/r", folderPath: "/tmp/r", githubId: "7")?.type, "folder")
        XCTAssertEqual(try library.get(repo.id)?.lastEdited, repo.lastEdited, "learning about a repository is not an edit")
    }

    func testSandboxRunsRestrictAndMilestoneBackfill() throws {
        let root = tempDir("engelbart-db-")
        let library = try LibraryDB.open(root: root)
        let row = try library.insert(NewLibraryRow(name: "o/r", type: "website", tags: ["git"], url: "https://github.com/o/r"))
        let log = #"[{"message":"Creating sandbox"},{"kind":"stdout","message":"x"}]"#
        try library.query("insert into sandbox_runs (id, library_id, status, build_log, build_milestones) values (?, ?, 'stopped', ?, null)", [.text(uuid()), .text(row.id), .text(log)])
        XCTAssertThrowsMatchingSync({ try library.remove(row.id) }, "FOREIGN KEY")
        XCTAssertThrowsMatchingSync({ try library.query("insert into sandbox_runs (id, library_id, port) values (?, ?, 70000)", [.text(uuid()), .text(row.id)]) }, "CHECK")
        XCTAssertThrowsMatchingSync({ try library.query("insert into repo_runnables (id, library_id, name, type, run_command) values (?, ?, 'web', 'ui', 'npm start')", [.text(uuid()), .text(row.id)]) }, "CHECK")
        library.close()
        let again = try LibraryDB.open(root: root)
        let milestones = try JSONValue.parse(again.query("select build_milestones from sandbox_runs")[0]["build_milestones"]!.string!)
        XCTAssertNotNil(milestones["message:Creating sandbox"], "a run from before the column is backfilled")
    }

    func testNotesSchemaInsertRenameAndPostIts() throws {
        let projectDir = Paths.join(tempDir("engelbart-db-"), "Project")
        try FileManager.default.createDirectory(atPath: projectDir, withIntermediateDirectories: true)
        let notes = try NotesDB.open(projectDir: projectDir)
        let id = uuid()
        let row = try notes.insert(id: id, name: "Note", path: "Note.md")
        XCTAssertEqual(row.path, "Note.md"); XCTAssertNil(row.goalId)
        usleep(5000)
        let renamed = try notes.rename(id, name: "Better", path: "Better.md")!
        XCTAssertEqual([renamed.name, renamed.path], ["Better", "Better.md"])
        XCTAssertGreaterThanOrEqual(renamed.lastEdited, row.lastEdited)
        XCTAssertEqual(JSONValue.encode(renamed).object!.keys.sorted(), ["created", "goal_id", "id", "last_edited", "name", "path", "topic_id"])
        XCTAssertEqual(try notes.list().count, 1)
        XCTAssertTrue(NotesDB.close(projectDir: projectDir))
        XCTAssertFalse(NotesDB.close(projectDir: projectDir))
        XCTAssertEqual(try NotesDB.open(projectDir: projectDir).list()[0].name, "Better")

        let cards = try NotesDB.open(projectDir: projectDir).postIts
        let card = uuid()
        try cards.create(id: card, PostItValues(text: "hi", nx: 0.5, ny: 0.5, width: 200, height: 160, z: 1))
        XCTAssertThrowsMatchingSync({ try cards.create(id: uuid(), PostItValues(text: "x", nx: 2, ny: 0, width: 200, height: 160, z: 0)) }, "Sticky nx is out of range")
        XCTAssertThrowsMatchingSync({ try cards.create(id: uuid(), PostItValues(text: "x", nx: 0, ny: 0, width: 100, height: 160, z: 0)) }, "Sticky width is out of range")
        XCTAssertEqual(try cards.trash(card)?.id, card)
        XCTAssertNil(try cards.trash(card), "trashed once")
        XCTAssertEqual(try cards.list().count, 0); XCTAssertEqual(try cards.trashed().count, 1)
        XCTAssertNotNil(try cards.update(id: card, PostItValues(text: "edited", nx: 0, ny: 0, width: 200, height: 160, z: 0))?.deleted, "update leaves deleted alone")
        XCTAssertEqual(try cards.restore(card)?.deleted, nil)
        try cards.trash(card)
        XCTAssertEqual(try cards.purge(before: Date().addingTimeInterval(60)), 1)
        XCTAssertNil(try cards.update(id: card, PostItValues(text: "late", nx: 0, ny: 0, width: 200, height: 160, z: 0)), "a save in flight does not resurrect a purged card")
    }

    /// A library typed the old way (before 2026-09-21) is converted in place, once, after a copy of it is set aside.
    func testOldTypedLibraryIsConvertedOnceAfterABackup() throws {
        let root = tempDir("engelbart-db-old-")
        let file = Paths.join(root, "library.sqlite")
        let raw = try SQLiteDatabase(path: file)
        try raw.execute("""
            create table library (id text primary key, name text not null, type text not null check (type in ('note','paper','git_repo','dataset','website','image')),
              path text, url text, folder_path text, project_id text, created text not null, last_edited text not null,
              summary text, summary_edited text, char_count integer, github_id text);
            """)
        let was: [(String, String, String?, String?, String?)] = [
            ("note", "A note", "/p/A note.md", nil, nil), ("paper", "Downloaded", "/lib/attention.pdf", nil, nil),
            ("paper", "arXiv 1706.03762", nil, "https://arxiv.org/abs/1706.03762", nil), ("git_repo", "o/address-only", nil, "https://github.com/o/address-only", nil),
            ("git_repo", "o/cloned", nil, "https://github.com/o/cloned", "/code/cloned"), ("dataset", "rows.csv", "/data/rows.csv", nil, nil),
            ("dataset", "events.ndjson", "/data/events.NDJSON", nil, nil), ("dataset", "tables", nil, nil, "/data/tables"),
            ("website", "A page", nil, "https://example.org/", nil), ("website", "report.html", "/pages/report.htm", "file:///pages/report.htm", nil),
            ("image", "Attachment 1", "/p/assets/1.png", nil, nil),
        ]
        var ids: [String] = []
        for (type, name, path, url, folder) in was {
            let id = uuid(); ids.append(id)
            try raw.run("insert into library (id, name, type, path, url, folder_path, summary, summary_edited, last_edited, created, char_count) values (?, ?, ?, ?, ?, ?, ?, '2026-09-10T00:00:00.000Z', '2026-09-09T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1234)",
                        [.text(id), .text(name), .text(type), .of(path), .of(url), .of(folder), .text("about \(name)")])
        }
        raw.close()
        let library = try LibraryDB.open(root: root)
        let rows = try library.list()
        XCTAssertEqual(rows.map(\.id).sorted(), ids.sorted())
        let shape = Dictionary(uniqueKeysWithValues: rows.map { ($0.name, "\($0.type) \($0.tags)") })
        XCTAssertEqual(shape, [
            "A note": "md [\"note\"]", "Downloaded": "pdf []", "arXiv 1706.03762": "website [\"paper\"]", "o/address-only": "website [\"git\"]",
            "o/cloned": "folder [\"git\"]", "rows.csv": "csv []", "events.ndjson": "jsonl []", "tables": "folder []", "A page": "website []",
            "report.html": "html []", "Attachment 1": "image []",
        ])
        for row in rows {
            XCTAssertEqual([row.summary, row.summaryEdited, row.lastEdited], ["about \(row.name)", "2026-09-10T00:00:00.000Z", "2026-09-09T00:00:00.000Z"])
            XCTAssertEqual(row.charCount, 1234); XCTAssertNil(row.categorized)
        }
        XCTAssertEqual(try library.uncategorized(1).count, rows.count)
        func backups() -> [String] { (try? FileManager.default.contentsOfDirectory(atPath: Paths.join(root, ".backups")))?.filter { $0.hasPrefix("library-") && $0.hasSuffix(".sqlite") } ?? [] }
        XCTAssertEqual(backups().count, 1)
        let copy = try SQLiteDatabase(path: Paths.join(root, ".backups", backups()[0]))
        XCTAssertEqual(try copy.query("select type from library order by type").map { $0["type"]!.string! }, was.map(\.0).sorted(), "the copy is the database as it was")
        copy.close()
        library.close()
        let again = try LibraryDB.open(root: root)
        XCTAssertEqual(try again.list().map { "\($0.type)\($0.tags)" }, rows.map { "\($0.type)\($0.tags)" })
        XCTAssertEqual(backups().count, 1, "and sets nothing more aside")
    }

    func testMissingLaterColumnsAreAddedKeepingValues() throws {
        let root = tempDir("engelbart-db-cols-")
        let raw = try SQLiteDatabase(path: Paths.join(root, "library.sqlite"))
        try raw.execute("create table library (id text primary key, name text not null, type text not null, path text, url text, folder_path text, project_id text, created text not null, last_edited text not null, summary text, summary_edited text, char_count integer, github_id text, tags text not null default '[]', categorized integer)")
        try raw.run("insert into library (id, name, type, created, last_edited, tags, categorized, char_count) values ('11111111-1111-4111-8111-111111111111', 'Kept', 'pdf', 'c', 'e', '[\"paper\"]', 1, 1234)")
        raw.close()
        let row = try LibraryDB.open(root: root).get("11111111-1111-4111-8111-111111111111")!
        XCTAssertEqual([row.name, row.created, row.lastEdited], ["Kept", "c", "e"])
        XCTAssertEqual(row.tags, ["paper"]); XCTAssertEqual(row.charCount, 1234)
        XCTAssertNil(row.source); XCTAssertNil(row.titled)
    }
}
