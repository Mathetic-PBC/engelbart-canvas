# Store parity ledger

Ports `src/main/store/*.cjs`, `src/main/developer.cjs`, `src/main/context/pdf-kind.cjs`, the persisted parts of
`src/main/windows.cjs`, `src/shared/project-holds.cjs`, `address-key.cjs`, `github.cjs`, and the data handlers of
`src/main/ipc.cjs` / `index.cjs`. Package: `mac/Packages/Store` (module `EngelbartStore`). Tests: `Tests/EngelbartStoreTests`.
Format and statuses: `mac/ARCHITECTURE.md` §6. "done (cloud)": checked by `mac/scripts/cloud-test.sh Store` (84 XCTests, PASS, 2026-10-28, run 40757446597).

Mappings that hold everywhere (Electron mechanics → Swift):
- PGlite directories `library.pglite`, `<project>/notes.pglite` → SQLite files `library.sqlite`, `<project>/notes.sqlite`
  (WAL, `foreign_keys=ON`, one serial queue per database). uuid → lowercase TEXT; timestamptz → ISO-8601 TEXT with ms + Z;
  `text[]` → JSON array TEXT; jsonb → JSON TEXT; `'note' = any(tags)` → `json_each`/`instr(tags,'"note"')`.
- Files Electron writes with `JSON.stringify(v, null, 2) + '\n'` are written the same way but with sorted keys (Core's
  `JSONValue.text(pretty:)`); readers never depend on key order.
- `ipc.cjs` argument checks (`str(value, what, max)`) are kept where the Store's public methods take loose input
  (`StoreArgs.str`), with the same messages; trusted-renderer checks are n/a.

| # | Behaviour (one line, concrete: inputs → result, values) | Source | Swift | Status |
|---|---|---|---|---|
| **Database: library** |||||
| 1 | `library` columns: id, name, type, path, url, folder_path, project_id, created, last_edited, summary, summary_edited, char_count, github_id, tags (default `[]`), categorized, source, category, item_date, origin_url, place, messages, minutes, titled; `list()` rows carry exactly these 23 keys | db.cjs:32-76 | LibraryDB.swift | done (cloud) |
| 2 | type check `library_type_check`: md pdf html csv tsv json jsonl parquet xlsx docx folder website image; insert of another type → "Unknown library type: X" | db.cjs:25,92,334 | LibraryDB.swift | done (cloud) |
| 3 | tags ⊂ paper, git, note, deduped; non-list → "tags must be a list"; unknown → "Unknown library tag: X"; note on non-md → "Only a note written in Engelbart (an md) can be tagged note"; DB constraint `library_note_is_md` also refuses raw SQL | db.cjs:207-214,94 | LibraryDB.swift | done (cloud) |
| 4 | `library_github_id` partial unique index (github_id not null); github id must match `^[1-9]\d{0,18}$` → "github id must be a string of digits"; '' → null | db.cjs:54,201 | LibraryDB.swift | done (cloud) |
| 5 | about fields checked: source ∈ ITEM_SOURCES ("Unknown library source: X (one of …)", value cut at 60), category ∈ ITEM_CATEGORIES, item_date YYYY or YYYY-MM-DD, origin_url http(s) ≤ 8192, place whitespace-collapsed ≤ 512 ('' → null), messages/minutes non-negative ints ≤ 2e9 | db.cjs:216-264 | LibraryDB.swift | done (cloud) |
| 6 | requireText: null/'' → "<name> is required" (or null when optional); non-string/too long → "<name> must be a string of at most N characters"; id ≤ 64, name ≤ 512, path/url ≤ 4096 | db.cjs:314 | LibraryDB.swift | done (cloud) |
| 7 | list order `created, name`; get by id → row or nil | db.cjs:356-363 | LibraryDB.swift | done (cloud) |
| 8 | rename / updatePath set last_edited = now; touch; recordEdit(id, chars) sets last_edited + char_count; setCharCount not an edit | db.cjs:364-391 | LibraryDB.swift | done (cloud) |
| 9 | setSummary(id, text ≤ 4000, at): summary_edited = at (null with null text); never touches last_edited | db.cjs:394 | LibraryDB.swift | done (cloud) |
| 10 | setCategory(id, {type, tags}, rules): writes type/tags, categorized = coalesce(rules, categorized); unknown id → "Unknown library item" | db.cjs:405 | LibraryDB.swift | done (cloud) |
| 11 | uncategorized(rules): categorized null or < rules; settleUninferable marks images and notes, returns count | db.cjs:416-424 | LibraryDB.swift | done (cloud) |
| 12 | untitled(rules) / setTitle(id, name?, rules?) (coalesce both) / fillAbout (fills only null columns) / setSource | db.cjs:426-456 | LibraryDB.swift | done (cloud) |
| 13 | updateRepo(id, {name,url,folder_path,github_id}): type = folder when folder_path else website; not an edit | db.cjs:461 | LibraryDB.swift | done (cloud) |
| 14 | adoptPdf(id, file): only a website row with no path/folder → pdf with path, categorized null; else nil | db.cjs:471 | LibraryDB.swift | done (cloud) |
| 15 | uncountedNotes, summaryCandidates(quietBefore, minChars), papersWithFiles | db.cjs:479-500 | LibraryDB.swift | done (cloud) |
| 16 | library_text: setText (NUL stripped, upsert, extracted_at), textStamps (id → mtime), textsFor(ids, max) cut at max chars, empty text left out; ids non-array → "ids must be an array" | db.cjs:152-160,502-527 | LibraryDB.swift | done (cloud) |
| 17 | rewritePathPrefix(old, new, projectId?) → rows changed | db.cjs:534 | LibraryDB.swift | done (cloud) |
| 18 | remove(id) → Bool; a row a sandbox run names is refused (FK restrict) | db.cjs:100,542 | LibraryDB.swift | done (cloud) |
| 19 | sandbox_runs (status check, port 1–65535, build_log `[]`, build_milestones, env_revision, env_report, last_opened_at, kind, kind_reason, terminal; one active run per library row), sandbox_environments (cascade), repo_runnables (type ui/app/terminal, status, ui run_command holds `{port}`, unique (library_id, folder, name)) | db.cjs:98-162 | LibraryDB.swift | done (cloud) |
| 20 | on open: runs with null build_milestones get collectBuildMilestones(build_log) | db.cjs:326, build-history.cjs | LibraryDB.swift, BuildHistory.swift | done (cloud) |
| 21 | a library typed the old way (no `tags` column) is copied to `<root>/.backups/library-<ISO with :. → ->.sqlite` first, then converted: note→md+note, paper w/o path→website+paper, paper→pdf, git_repo→folder/website+git, dataset w/o path→folder, dataset→by extension (tsv json jsonl ndjson parquet xlsx else csv), website with path→html; summaries/last_edited untouched; categorized null; once | db.cjs:77-94,266-298 | LibraryDB.swift | done (cloud) |
| 22 | a library missing later columns gets them added, every value kept, new ones null | db.cjs:46-76 | LibraryDB.swift | done (cloud) |
| 23 | one open instance per file; closeDb(dir) → true once then false; closeAll | db.cjs:190,300-312 | SQLite.swift | done (cloud) |
| **Database: notes, post_its** |||||
| 24 | notes: id, name, path, goal_id, topic_id, created, last_edited; insert/list(created,name)/get/rename(updates path + last_edited)/touch | db.cjs:165,593-624 | NotesDB.swift | done (cloud) |
| 25 | post_its: text ≤ 400000, nx/ny 0–1, width 180–2400, height 140–2400, z ≥ 0 ("Sticky <key> is out of range"); list (not deleted, by z, created, id), create, update (UPDATE only, leaves deleted), trash, restore, trashed (deleted desc), purge(before), remove | db.cjs:175-188,555-637 | NotesDB.swift | done (cloud) |
| **Home, config, defaults** |||||
| 26 | ensureHome(homeDir, rootDir?, test:): root = rootDir or ~/.engelbart(-swift); makes root (0700), and with test `test/` + `test/annotations`; relative paths → TypeError | home.cjs:17 | Home.swift | done (cloud) |
| 27 | Swift data root default `~/.engelbart-swift`; `ENGELBART_ROOT_DIR`, `ENGELBART_HOME_DIR` overrides | ARCHITECTURE §3, index.cjs:621 | Store.swift | partial: Store.init reads ENGELBART_ROOT_DIR / ENGELBART_HOME_DIR as defaults; compiled, untested (tests pass dirs explicitly) |
| 28 | config.json normalized: testMode bool (default false), providers (aliases codex→openai, claude→anthropic; dedupe; none → both), summarizer {provider, openai{model gpt-6-luna, effort high}, anthropic{claude-opus-5-5, high}} with MODEL_RE and efforts low…max, github {clientId Iv23liAZNYl96zlluMDs, appSlug engelbart-mathetic} trimmed + validated, tools (normalizeTools) | home.cjs:39-102 | Home.swift, ToolsRecord.swift | done (cloud) |
| 29 | normalizeTools: updates auto/ask; git/claude/codex records (installed, version x.y.z, requires from minimums 2.30.0/2.1.278/0.155.0, status set, signedIn/account for agents only, absolute path, onPath, source set, untested, updaterOff, checkedAt ISO, error/note one line ≤ 300, failedUpdate, skip, pin) | tools/record.cjs | ToolsRecord.swift | done (cloud) |
| 30 | readConfig: unreadable → defaults; writeConfig(patch): only testMode/summarizer/providers/github/tools ("Unsupported config key: X"), testMode must be bool, writes atomically 0600 | home.cjs:121-143 | Home.swift | done (cloud) |
| 31 | writeTools only while config.json parses as an object, else nil and file untouched | home.cjs:149 | Home.swift | done (cloud) |
| 32 | carryDefaults: missing → write defaults + base; not an object/unparsable → untouched; three-way merge against `.defaults/<name>` (or base rebuilt from PAST_CONFIG_DEFAULTS); fillMissing; normalize; backup to `.backups/<stem>-<stamp>.json` once when no base; base rewritten only when defaults changed | defaults.cjs | Defaults.swift | done (cloud) |
| 33 | equal (key-order free, arrays ordered, absent ≠ null), merge3, rebuildBase exactly as tested | defaults.cjs:21-71 | Defaults.swift | done (cloud) |
| 34 | PAST_CONFIG_DEFAULTS: {testMode:true}, +summarizer(gpt-5.6-luna, claude-opus-5), +providers, +github | home.cjs:107 | Home.swift | done (cloud) |
| 35 | sanitizeName: control chars dropped, / and \ → -, colons dropped, whitespace collapsed, trimmed, leading dots dropped, ≤ 120, '' → Untitled | home.cjs:160 | Names.swift | done (cloud) |
| 36 | slugify: lower, non [a-z0-9] runs → -, trimmed dashes, ≤ 48 | home.cjs:177 | Names.swift | done (cloud) |
| 37 | uniqueName(dir, base, ext): base, "base 2", "base 3"… | home.cjs:182 | Names.swift | done (cloud) |
| 38 | developer: hasTestMode — ENGELBART_TEST_MODE=off → false; not packaged → true; packaged → build.json `developer === true` | developer.cjs | Developer.swift | done (cloud) |
| **Store modes (createStore)** |||||
| 39 | mode = test only when test mode is available and config.testMode; dataRoot = root/test or root | ipc.cjs:197-207 | Store.swift | done (cloud) |
| 40 | config() → config + testMode, testModeAvailable, mode, home, testRoot, dataRoot | ipc.cjs:201 | Store.swift | done (cloud) |
| 41 | context(): one per mode, opened once: ensureHome, library DB, seed (test mode, no `.fresh`), recategorize (awaited), describeRows (awaited), afterOpen in the background | ipc.cjs:213-240 | Store.swift | partial: open/seed/recategorize/describeRows cloud-tested; the background afterOpen (web-pdfs) untested (tests run webPdfs: false) |
| 42 | setTestMode(bool): "Test mode is only in developer builds of Engelbart"; closes contexts, writes config, posts `engelbart:data-root-changed` | ipc.cjs:252,365 | Store.swift | done (cloud) |
| 43 | resetTestData({fresh}): refused when unavailable / "Test mode is off"; wipes root/test, re-ensures, `.fresh` mark with fresh | ipc.cjs:264 | Store.swift | done (cloud) |
| 44 | seedIfEmpty: copies hypocompass.pdf, problems.csv into `<dataRoot>/seed`, inserts the four rows (pdf; arXiv 2310.05292 paper; mqo00/hypocompass git; backend/problems csv) once | library.cjs:28-55 | Library+Seed.swift, Resources/fixtures | done (cloud) |
| 45 | recheck(ctx): afterOpen again with `again: true` after an add whose row is a web-pdf candidate | ipc.cjs:242,1103 | Store.swift | partial: Store.recheck wired on add; compiled, untested |
| **Projects** |||||
| 46 | project.json {id, name, created, directory?, description?}; projectRecord: name falls back to folder; directory only when it exists (else directoryMissing); description trimmed; defaultTarget/defaultRepo; library/removed id lists | projects.cjs:157-183 | Projects.swift | done (cloud) |
| 47 | listing: subdirs of dataRoot not dot, not `.pglite`, not annotations/seed/test/worktrees, with a project.json id | projects.cjs:39-45,72,190 | Projects.swift | done (cloud) |
| 48 | first touch of a project runs migrateProjectDir once per process | projects.cjs:162 | Projects.swift | done (cloud) |
| 49 | findProject: bad id → "project id is invalid"; none → "Unknown project" | projects.cjs:194 | Projects.swift | done (cloud) |
| 50 | listProjects: each with workspaceCount, lastEdited (latest mtime 3 deep, no dot/.pglite/.sqlite/top-level builds, else created), recent (4 workspaces by workspace.md mtime, text ≤ 4000), libraryIds (holder rule); newest lastEdited first | projects.cjs:84-247 | Projects.swift | done (cloud) |
| 51 | createProject(name or {name, path, directory, description}): sanitized name, slug (path or name; reserved → `-project`; collisions " 2"), directory checked ("directory must be an absolute path"/"does not exist"/"must be a directory"), description ≤ 4000, writes project.json + `.project.md` (description + \n or empty), opens notes DB | projects.cjs:255-290 | Projects.swift | done (cloud) |
| 52 | createProjectWithWelcome: workspace "Getting started" (or given), Welcome! note with WELCOME_NOTE, context [note, …chosen], description written as the workspace document | projects.cjs:295-302 | Projects.swift | done (cloud) |
| 53 | createProjectWithWelcomePage: workspace "Welcome to Engelbart!", welcome.png saved as image "Attachment 1", page text `![Attachment 1](img:<id>)` + thanks lines, context | projects.cjs:307-334 | Projects.swift, Resources/welcome.png | done (cloud) |
| 54 | setProjectDirectory; setDefaultTarget ({kind:project} or {kind:library,id}; else "the default repo must be the code directory or a library row"; unchanged → not rewritten) | projects.cjs:336-355 | Projects.swift | done (cloud) |
| 55 | renameProject: name changes; folder follows only while slug == slugify(old name); notes DB closed, folder moved, library paths rewritten | projects.cjs:357-378 | Projects.swift | done (cloud) |
| 56 | trashProject: refuses a code folder inside the project folder ("<name>'s code folder is inside its Engelbart folder, so deleting the project would take the code with it."); stopBuilds first; `trashed {at, slug, name}` written before the move (restored on failure); into `<dataRoot>/.trash/<unique>`; paths rewritten | projects.cjs:424-447 | Projects+Trash.swift | done (cloud) |
| 57 | trashedProjects(now): cut-short ones finished as restored; ≥ 7 days purged (worktrees of open/keptCopy Builds removed via closure, rows made there removed, state forgotten, folder last); list {id,name,deleted,expires,workspaceCount} newest first | projects.cjs:449-497 | Projects+Trash.swift | done (cloud) |
| 58 | restoreProject: half-done one settled; else old slug when free, else freeSlug; open Builds' worktrees follow (moveWorktree; failure → removeWorktrees + record discarded with message "Its copy could not be moved when the project came back from the trash (…), so it was discarded."); "That project is no longer in the trash" | projects.cjs:504-547 | Projects+Trash.swift, BuildRecords.swift | done (cloud) |
| 59 | forgetProject: views, stages, recent, agents, starred entries of the project go | projects.cjs:1205 | State.swift | done (cloud) |
| **Workspaces** |||||
| 60 | meta.json {id, status (open/progress/done, kept only as marker), context, created, chars, builds, archives, removed, picked, trashed?}; a folder without a valid status is no workspace | projects.cjs:33-36,551 | Workspaces.swift | done (cloud) |
| 61 | context read with contextOf (flat; on failure the valid ids, ≤ 2000); chars measured when absent; builds `^[a-z0-9]{6,32}$`; archives ARCHIVE_RE, title ≤ 200 | projects.cjs:147,551-566 | Workspaces.swift | done (cloud) |
| 62 | validateTree/flatContext: ids or folders flattened, deduped; > 2000 → "context has too many entries"; depth > 6 → "context folders are nested too deep"; bad → "context entry must be an id or a folder" / "library item id is invalid" | projects.cjs:100-140 | Workspaces.swift | done (cloud) |
| 63 | workspaces sorted by created; `assets`, `builds` never workspaces; workspace dir name sanitized, reserved/.pglite → "<name> workspace", unique | projects.cjs:576,659-664 | Workspaces.swift | done (cloud) |
| 64 | flattenWorkspaces with paths "A/B"; referencedBy; workspaceTree with folder, edited (workspace.md mtime), children | projects.cjs:599-646 | Workspaces.swift | done (cloud) |
| 65 | createWorkspace(name default "Untitled Workspace 1", parentId): depth ≥ 3 under the project → "Projects go four levels deep: there is no room for one inside this one."; meta + empty workspace.md | projects.cjs:669-683 | Workspaces.swift | done (cloud) |
| 66 | renameWorkspace (same sanitized name → unchanged; children move with it) | projects.cjs:685 | Workspaces.swift | done (cloud) |
| 67 | trashWorkspace into `<project>/.trash/<unique name>` with `trashed {at, name, parentId}`; trashedWorkspaces (≥ 7 days purged; {id,name,deleted,expires,nested}); restoreWorkspace under its parent or the top, unique name, `trashed` dropped; "That workspace is no longer in the trash" | projects.cjs:697-745 | Workspaces.swift | done (cloud) |
| 68 | setWorkspaceContext, addWorkspaceBuild (≤ 500 kept, "build id is invalid"), patchWorkspace | projects.cjs:747-764 | Workspaces.swift | done (cloud) |
| 69 | linkToWorkspace(ids, picked): appended once each; off `removed`; picked only for ones not linked already; linked without picked → off picked; > 2000 → "This workspace's sidebar is full (2000 items): take some out first. Everything stays in the library." | projects.cjs:774-784 | Workspaces.swift | done (cloud) |
| 70 | unlinkFromWorkspace(id(s), unmentioned): unmentioned only removes picked ones (not remembered); else out of context/picked, onto removed (≤ 1000) | projects.cjs:789-796 | Workspaces.swift | done (cloud) |
| 71 | recountWorkspaces: stored chars follow an outside edit; never-counted left alone | projects.cjs:633 | Workspaces.swift | done (cloud) |
| 72 | notesMadeIn: note id → topic_id; notes DB not opened when no workspace removed anything | projects.cjs:625 | Workspaces.swift | done (cloud) |
| **Project's own list** |||||
| 73 | addToProject(ids ≤ 200 "At most 200 items can be added or removed at once; N were sent."; unknown → "Not in the library: …"): onto library, off removed; with workspace links as many as fit → {added, inWorkspace} | projects.cjs:804-841 | ProjectList.swift | done (cloud) |
| 74 | removeFromProject: refuses rows made here with source null/engelbart ("Made in this project, so it goes to the trash instead of being removed (only what was brought in from elsewhere can be removed): …"); off library, onto removed, unlinked from every workspace → {removed} | projects.cjs:849-858 | ProjectList.swift | done (cloud) |
| 75 | keepInProject(ids): fresh ids (not listed, not removed) appended | projects.cjs:864 | ProjectList.swift | done (cloud) |
| 76 | projectItemMentions: workspaces whose workspace.md mentions the row (lib id or plain name, case-free) | projects.cjs:872, mentions.cjs | ProjectList.swift, Mentions.swift | done (cloud) |
| 77 | holder / letGo rule (project-holds.cjs) | shared/project-holds.cjs | ProjectHolds.swift | done (cloud) |
| **Notes, images, documents** |||||
| 78 | createNote: unique stem in the project (`.md`), file written, notes row (topic_id = workspace), library row md+note, source engelbart, category note, char count | projects.cjs:893-905 | Notes.swift | done (cloud) |
| 79 | noteHome: a note of another project (library project_id) opens/saves/renames in its own project; "Unknown note" | projects.cjs:910-926 | Notes.swift | done (cloud) |
| 80 | renameNote: same name → unchanged; unique stem; file moved; notes + library rows renamed, path updated | projects.cjs:928 | Notes.swift | done (cloud) |
| 81 | saveImage: png/jpeg/gif/webp only ("Only png, jpeg, gif and webp images can be attached"), 1 byte–20 MB ("The image is empty or larger than 20 MB"), `<project>/assets/<id>.<ext>`, image row (source engelbart, category image), label sanitized default "Attachment" | projects.cjs:946-960 | Notes.swift | done (cloud) |
| 82 | readImage: image rows only ("Unknown image"), inside dataRoot ("The image is outside the data root"), mime by extension | projects.cjs:962 | Notes.swift | done (cloud) |
| 83 | resolveDoc note/workspace/project ("Unknown doc kind", "doc ref must be an object") | projects.cjs:974 | Docs.swift | done (cloud) |
| 84 | readDoc: a project page missing is made from its description; unreadable → '' | projects.cjs:1007 | Docs.swift | done (cloud) |
| 85 | writeDoc: string ≤ 5 MB ("doc text must be a string under 5 MB"); same text → {lastEdited: null}; else atomic write, note touch + recordEdit(chars), workspace chars → {lastEdited} | projects.cjs:1018 | Docs.swift | done (cloud) |
| 86 | write-doc revisions: per (project, key) counter; a change posts `doc:changed {projectId, key, text, revision}`; answers {lastEdited, revision}; saves of one document in turn | ipc.cjs:330-348,616-624 | Store+Docs.swift | done (cloud) |
| 87 | projectPageBlock: `<project_page …>` unless empty or equal to the description | projects.cjs:994 | Docs.swift | done (cloud) |
| 88 | readProjectTextFile: typed path (file://, ~/, absolute, else project/engelbart folder/root/code dir), home only ("Only files inside your home directory can be opened"), dir listing, ≤ 2 MB, 20000 chars + truncated | projects.cjs:1452-1504 | TextFiles.swift | done (cloud) |
| 89 | resolvePageFile: html/htm/pdf that exists → {path, url (+#/? rest)}; else nil | projects.cjs:1471 | TextFiles.swift | done (cloud) |
| 90 | loadProject → {project, workspaces (tree), notes, trash} | projects.cjs:1508 | Projects.swift, Models.swift | done (cloud) |
| **state.json** |||||
| 91 | writeState MERGES: every field kept, projectId/workspaceId re-read, topicId/goalId dropped | projects.cjs:1047 | State.swift | done (cloud) |
| 92 | lastOpen {projectId, workspaceId (or topicId)}, bad ids → null | projects.cjs:1042-1059 | State.swift | done (cloud) |
| 93 | windows [{projectId, workspaceId, bounds {x,y,width,height} rounded, \|n\| ≤ 1e5, ≥ 100×100 else null}] ≤ 24 | projects.cjs:1066-1100 | State.swift | done (cloud) |
| 94 | views[project][workspace] = {active ('ws' or a tab id), tabs ≤ 40 (id, title ≤ 200, kind workspace), positions ≤ 200 (`ws:`/`note:` keys; top, line, offset, hash)}; errors "a view needs a project id and a workspace id", "view is invalid" | projects.cjs:1102-1150 | State.swift | done (cloud) |
| 95 | stages[project] = cleanStage: item or address (http/https/file or absolute path, ≤ 2048, not about:), deduped by item or addressKey, ≤ 15, title ≤ 200, active remapped/clamped; "a Stage needs a project id", "stage is invalid" | projects.cjs:1152-1203 | State.swift | done (cloud) |
| 96 | starred[project]: ids once each, oldest first, ≤ 500; re-star moves last; "a star needs a project id and a library id" | projects.cjs:1225-1250 | State.swift | done (cloud) |
| 97 | folders: [{id, name (sanitized ≤ 120), items ≤ 2000, created}] ≤ 200; create ("A folder needs a name", "At most 200 folders"), rename, delete, addToFolder (dedupe), removeFromFolder; "Unknown folder" | projects.cjs:1254-1336 | State.swift | done (cloud) |
| 98 | recent: newest first, once each, the first three whatever their age plus any within 30 min, ≤ 100; recordEdit("Unknown workspace") | projects.cjs:1351-1430 | State.swift | done (cloud) |
| 99 | agents: kinds bart/brainstorm/discover/create/build, running/waiting, running rows of an earlier run not read, doc refs cleaned (workspace/note/mark), ≤ 50; agentStarted/Finished/Stopped; seenAgents → count | projects.cjs:1342-1449 | State.swift | done (cloud) |
| 100 | readNav: recent and agents with names {name, path, projectName}; gone ones dropped | projects.cjs:1393 | State.swift | done (cloud) |
| 101 | `engelbart:nav` posted on record-edit, seen-agents (when > 0), create/trash/restore workspace, trash/restore project | ipc.cjs:398,506,553-565 | Store.swift | done (cloud) |
| 102 | window places: cleanPlace, placement (on-screen ≥ 200×120, min 900×560, default 1440×900, +24 step) | windows.cjs:24-49 | WindowPlaces.swift | done (cloud) |
| **Archive (Clear / Archived)** |||||
| 103 | stampOf `YYYY-MM-DDTHH-MM-SSZ` UTC; freeStamp `-2`, `-3`… | archive.cjs:21,74 | Archive.swift | done (cloud) |
| 104 | titleOf: first line with words, markdown/mentions/agent lines stripped, ≤ 120, else "Untitled" | archive.cjs:26 | Archive.swift | done (cloud) |
| 105 | mentionsIn: images by `img:` id, workspaces by `ws:`, plain `@[Name]` by name (this project's row first) | archive.cjs:35 | Archive.swift | done (cloud) |
| 106 | clearWorkspace(keep): nothing but kept/blank → not archived; else `.archive/<stamp>.md` + `.json` {file, clearedAt, title, context, removed, mentions, workspaces, builds}; mentioned ids linked (not removed ones); doc = kept lines; archives ≤ 500, chars | archive.cjs:84 | Archive.swift | done (cloud) |
| 107 | importTask (post-it): "Imported from Task:\n<body>\n\nbuild> <id>\n" as an archived version; build id `^[0-9a-f]{10}$` | archive.cjs:111 | Archive.swift | done (cloud) |
| 108 | readArchive ("archive is invalid", "That version is gone"), latestArchive, restoreArchive (current archived first, kept lines carried after, context + mentions relinked) | archive.cjs:131-166 | Archive.swift | done (cloud) |
| 109 | clear/restore answer with revision and post `doc:changed` + `engelbart:project-changed` | ipc.cjs:1075-1087 | Store+Docs.swift | partial: Archive.clear/restore cloud-tested; Store's revision + doc:changed for them compiled, untested |
| **Migration of the old layout** |||||
| 110 | migrateProjectDir: goals (meta box current/experimental/past, no status) → `.legacy/<Goal>`, topics up to the project (unique names), folders flattened, backup to `<dataRoot>/.backups/<project>-<stamp>/` without DB files, migration log; dryRun report; null when nothing | migrate.cjs | Migrate.swift | done (cloud) |
| **Library: listing, files, annotations** |||||
| 111 | readLibraryFile: uuid ("library id is invalid"), "This item has no local file", only .pdf ("Only downloaded pdf files open for now"), inside home ("The file is outside your home directory"), ≤ 200 MB ("The file is not a readable pdf"), ENOENT → "Nothing is at that path", EPERM/EACCES → BLOCKED message | library.cjs:61, stage/files.cjs:32 | Library+Files.swift | partial: messages and ENOENT cloud-tested; EPERM/EACCES to BLOCKED mapping compiled, untested |
| 112 | annotations: `<dataRoot>/annotations/<id>.json`; readAnnotations falls back to page ink by the row's file URL, addressKey and raw address; writes JSON ≤ 20 MB ("annotations are too large"), atomic 0600; one write at a time | library.cjs:71-104,368 | Library+Ink.swift | done (cloud) |
| 113 | page ink: `annotations/pages/<sha256(address)>.json`; inkPlace: preview address → none; a row by sameAs → its id; else addressKey file then older raw spelling; writePageAnnotations → false for previews | library.cjs:106-191 | Library+Ink.swift | done (cloud) |
| 114 | inkFileOf, annotationsFileOf, carryInk (copied to the row when it has none) | library.cjs:131-176 | Library+Ink.swift | done (cloud) |
| 115 | addMarkAnswer (withAsk, page or "web"), addWebMark (crop written first, removed on failure), updateWebMark (note/box/text; box stays box; new crop name), removeWebMark (pictures deleted, returned for undo), restoreWebMark, readWebMark, cropFile `annotations/crops/<id>.png` | library.cjs:193-366, boxes.cjs | Library+WebMarks.swift | done (cloud) |
| 116 | projectsForLibraryItem → [{id, name, origin, workspaces [{id,name,path}]}]; libraryForProject → rows + origin + workspaces paths | library.cjs:378-400 | Library+Holds.swift | done (cloud) |
| 117 | bodiesForProject/bodiesForLibrary: pdf text (library_text) and md files inside home/dataRoot, workspace.md per workspace, each ≤ 500000 chars | library.cjs:405-475 | Library+Holds.swift | done (cloud) |
| **Library: adding** |||||
| 118 | resolveAddition: quotes stripped; bare host → https; arXiv/DOI/GitHub/other remotes/http(s); file:// and ~; absolute only ("Paste a link, or a path that starts with / or ~/"); "Nothing is at that path"; home only ("Only files inside your home directory can be added"); folder (git tag + remote name); FILE_TYPES; html gets file URL; unknown → "Engelbart does not know what a .x is yet"; "Paste a link or a path"; "That link is not a valid address" | library.cjs:617-662 | Library+Resolve.swift | done (cloud) |
| 119 | canonicalRemote / repoKey / readCloneRemote (gitdir file, commondir, origin first, ≤ 1 MB) / findProjectClone | library.cjs:502-561 | Library+Repos.swift | done (cloud) |
| 120 | sameAs: repository by github id, else by repo address (not against a different id); else same path/folder or same page by addressKey | library.cjs:672-686 | Library+Resolve.swift | done (cloud) |
| 121 | learnRepo: folder, id, renamed name (only when the name was the old owner/name), moved clone | library.cjs:694-704 | Library+Repos.swift | done (cloud) |
| 122 | lookupItem → {row, found, error} | library.cjs:721 | Library+Resolve.swift | done (cloud) |
| 123 | addItem: outside-home png/jpg/gif/webp/pdf → copy; identifyRepo; EXISTS "Already in the library as “X”" (with row; repo learns first); project clone found; describe plain pages; name given ≤ 200; source by kind; pdf inspected; description → summary ≤ 1200 | library.cjs:743-794 | Library+Add.swift | done (cloud). Mapping: an `about` source/category of nil falls back to what the add tells; Electron also let an import pass an explicit null, not distinguished here |
| 124 | addPdfCopy: http(s) only ("Only a pdf from the web is saved as a copy"), %PDF- in first 1024 ("That is not a pdf"), ≤ 200 MB; `assets/pdfs/<id>.pdf`; name from address segment; ink carried; inspected | library.cjs:796-848 | Library+Add.swift | done (cloud) |
| 125 | addPageCopy: plain page only; `assets/pages/<id>/index.html` via save closure; "The page changed before it was saved. Save it again." / "The page was not saved"; folder removed on failure; summary from the copy's meta | library.cjs:850-900 | Library+Add.swift | done (cloud) |
| 126 | addMarkdownCopy: `assets/md/<id>/<stem>.md` + pictures; title cleaned ≤ 200 / Untitled; titled = TITLE_RULES | library.cjs:902-932 | Library+Add.swift | done (cloud) |
| 127 | addFileCopy: png/jpeg/gif/webp (≤ 20 MB, sniffed) or pdf (≤ 200 MB); messages per test; url → EXISTS check; raw GitHub file is the file; names (given, last segment, "Image"/"Untitled pdf"); file removed when the row fails | library.cjs:934-1037 | Library+Add.swift | done (cloud) |
| 128 | addFromUrl: http(s) only ("Only http(s) links can be added"), download with accept header and 60 s timeout; picture/pdf copy, else addItem; too large refused | library.cjs:1039-1109 | Library+Add.swift | done (cloud) |
| **Library: categories, titles, peek** |||||
| 129 | recategorize: CATEGORY_RULES = 1; settleUninferable; typeOfRow; tags only added (address, github_id, .git); pdf missing/no reader → due; unreadable/timeout (15 s) → settled; report {changed, due} | library.cjs:1121-1150 | Library+Recategorize.swift | done (cloud) |
| 130 | describeRows (TITLE_RULES = 1): rowAbout (head lines, engelbart/github/web/mac), fillAbout; rename rows named by their file: pdf metadata Title (pdfTitle), md first `# ` heading outside fences; missing → due | library.cjs:1152-1272 | Library+Describe.swift | done (cloud) |
| 131 | headAbout: chat apps `*App · day · project*` (turns counted ≤ 4 MB), Gmail (last day of the span), Google Drive, Overleaf links; dayOf | library.cjs:1175-1215 | Library+Describe.swift | done (cloud) |
| 132 | previewItem: md text ≤ 6000, csv/tsv/json/jsonl first 12 lines (≤ 2 MB), folder files (dirs first, ≤ 40, no .git/.DS_Store), project clone remembered, folderMissing as ~/…, owner + remote files | library.cjs:1281-1346 | Library+Peek.swift | done (cloud) |
| **Folder files** |||||
| 133 | listFolder / folderFile / folderFiles / fileInRow exactly as folder-files.cjs (segments, symlinks kept inside, ≤ 2000 entries, ≤ 200 per batch, messages) | folder-files.cjs | FolderFiles.swift | done (cloud) |
| **Page meta (network)** |||||
| 134 | readHtmlMeta: `<title>` (decoded) else og:title; description else og:description; ≤ 300000 chars | page-meta.cjs:14-36 | PageMeta.swift | done (cloud) |
| 135 | describer: http(s) only, 4 s timeout, html content type only; identifyRepo (id, full_name, url, description; signed in with retry signed out on 401/403); remote file lister (dirs first, ≤ 40, remembered) | page-meta.cjs:38-94 | PageMeta.swift | partial: describer/identifier/lister cloud-tested with fake fetches; the default URLSession HTTP.fetch compiled, untested (no network in tests) |
| **Web pdfs** |||||
| 136 | candidate / pending / record `<dataRoot>/.migrations/web-pdfs.json` {version 1, rows} / ≤ 5 attempts / sure ones first / 2 in parallel / adoptPdf / onChange / `again` follow-up run / one run per data root | web-pdfs.cjs | WebPdfs.swift | done (cloud) |
| 137 | readPdfResponse: HTTP error throws "The address answered N"; dropped after first bytes when not %PDF; > max → "The pdf is larger than 200 MB" | web-pdfs.cjs:79 | WebPdfs.swift | done (cloud) |
| 138 | ENGELBART_WEB_PDFS=off: no checker | index.cjs:636 | Store.swift | partial: Store(webPdfs:) defaults from ENGELBART_WEB_PDFS; compiled, untested |
| **Onboarding, getting started** |||||
| 139 | instructions.md: read trimmed; write trimmed ≤ 20000 + \n; empty removes; instructionsBlock `<custom_instructions note="…">` | onboarding.cjs:24-43 | Onboarding.swift | done (cloud) |
| 140 | freeFolder ~/<slug or my-project>, -2, -3… → {path, shown}; existingFolder (~, "Choose a folder", "A folder path starts with / or ~/", "Nothing is at X", "X is not a folder") | onboarding.cjs:45-68 | Onboarding.swift | done (cloud) |
| 141 | startProject (new folder made / existing; context filtered: known, not notes; welcomePage → the Welcome page project) ; addWelcomeWorkspace ("Welcome", unique) | onboarding.cjs:76-106 | Onboarding.swift | done (cloud) |
| 142 | discardItem: not a note, not made in a project, held by none; release first | onboarding.cjs:113 | Onboarding.swift | done (cloud) |
| 143 | getting-started.json in `<project>/.context`: {workspaceId, ticked 1–3 sorted, hidden}; set ticks/unticks; hidden stays; "This project has no walkthrough" | getting-started.cjs:14-56 | GettingStarted.swift | done (cloud) |
| 144 | `.guided-setup.json` {seen, how (shown/started/dismissed/onboarded), at}; due unless seen; ENGELBART_CONNECT_OFFER=off hides; start-project with onboarding marks 'onboarded' | getting-started.cjs:58-80, ipc.cjs:520 | GettingStarted.swift, Store.swift | partial: offer file cloud-tested; ENGELBART_CONNECT_OFFER=off gate compiled, untested |
| 145 | connect offer file `.connect/offer.json` {seen, how, at} | ipc.cjs:648-656 | GettingStarted.swift | done (cloud) |
| **Shared helpers** |||||
| 146 | addressKey (http/https, www., trailing slash, fragment, tracking params utm_*/fbclid/gclid/mc_cid/mc_eid/ref) and isPreviewAddress (localhost, *.localhost, ::1, 0.0.0.0, 127.x, *.e2b.app/dev) | address-key.cjs | AddressKey.swift | done (cloud) |
| 147 | isGithubSignIn / endedGithubSession / session cookie names | shared/github.cjs | GitHubLinks.swift | done (cloud) |
| 148 | pdf-kind: paperSignals (arXiv stamp, doi in metadata or page 1, abstract heading, keywords heading, references line up to page 60 only when one other signal), isPaper, inspectPdf → ['paper']/[], pdfTitle (Info Title unless no-title/template/not-a-name); unreadable throws | context/pdf-kind.cjs | PdfKind.swift (PDFKit) | partial: PDFKit page text + Info dictionary; every pdf-kind test passes in the cloud (fixture included); the XMP packet is not read for a DOI (PDFKit exposes only the Info dictionary) |
| **Events and app wiring** |||||
| 149 | `engelbart:project-changed {projectId}` after every saving handler with a project; `{projectId, trashed: true}` on trash | ipc.cjs:315-326,540 | Store.swift | done (cloud) |
| 150 | `engelbart:library-changed` after library-changing handlers (add-library-*, create-note, save-image, rename-note, rename-library-item, discard, start-project, welcome-workspace) and debounced 400 ms after a web pdf saved | ipc.cjs, index.cjs:631 | Store.swift | partial: library-changed after adds cloud-tested; the 400 ms debounce after a web pdf saved compiled, untested |
| 151 | `engelbart:starred {projectId, ids}`, `engelbart:folders {folders}` | ipc.cjs:404-418 | Store.swift | done (cloud) |
| 152 | `engelbart:data-root-changed {config, fresh}` on set-test-mode / reset-test-data | ipc.cjs:365-388 | Store.swift | partial: posted by setTestMode/resetTestData; compiled, payload not asserted |
| 153 | library additions queued one at a time; a data-mode change waits for them ("Data mode is already changing", "Wait for the data mode change to finish") | ipc.cjs:349-372 | Store.swift | partial: SerialLane queue + changingMode refusals compiled, untested |
| 154 | add hooks: pdfAdded() for pdf rows; sandbox start for GitHub repos (closure; `sandbox_error` on the row) | ipc.cjs:1103-1112 | Store.swift | partial: pdfAdded cloud-tested; startSandbox hook (sandbox_error) compiled, untested |
| 155 | rename-library-item: a note made in a project is renamed as a note | ipc.cjs:1214 | Store.swift | done (cloud) |
| 156 | pick-library-paths: ENGELBART_PICK_PATHS JSON, else open panel (pdf filter for 'pdf') | index.cjs:1312 | Store.swift | partial: ENGELBART_PICK_PATHS cloud-tested; NSOpenPanel default compiled, untested |
| 157 | created-file / created-save | ipc.cjs:957 | — | n/a: bart/create.cjs, owned by the Bart package (it calls Store's library insert through its adapter) |
| 158 | stage-file (readStageFile) | projects.cjs:1482 | TextFiles.swift (resolveTypedPath public) | n/a: stage/files.cjs reading is the Stage package's; Store exposes `resolveTypedPath` for it |
| 159 | copy-doc (expandDoc) | ipc.cjs:827 | — | n/a: context/expand-mentions.cjs is the Bart package's |
| **Importer** |||||
| 160 | importElectronRoot(from:to:): clone every file except `*.pglite` (APFS clonefile), then convert library.pglite and each project's notes.pglite from a COPY via a Node script (Electron runtime with ELECTRON_RUN_AS_NODE + app.asar.unpacked pglite, fallback node + repo node_modules) into SQLite | ARCHITECTURE §3 | Importer.swift, Resources/pglite-dump.cjs | done (cloud): end to end on the runner (Node 22 + pglite 0.5.8), run 40757446597; the Electron-runtime path (Engelbart.app as Node) was never launched |
