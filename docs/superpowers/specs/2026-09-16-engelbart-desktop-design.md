# Engelbart desktop (experiment branch) — design spec

Date: 2026-09-16. Status: implemented from this spec without an approval gate (autonomous session); every interpretation is listed in §2 so it can be overridden.

## 1. What this is

A macOS desktop app named **Engelbart**, installed like Experimental Terminal (an unsigned Electron `.app` under `release/`). It is a **simulation / testing environment** for the *Goal Canvas* design (`design/goal-canvas/Goal Canvas.dc.html`, plus the 33 tweak messages in `design/goal-canvas/USER-TWEAKS.md`). Nothing is wired to a model. The point is to iron out storage, representation and interaction details before agents are attached, and to be usable for planning in the meantime.

Out of scope now: live preview, dataset viewer (both render the word *placeholder*), any LLM call, document import/upload, sync, auth.

## 2. Interpretations (decisions taken; override any of them)

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | "`.engelbart/` at my computer's root" | `~/.engelbart/` (home directory), created on first launch. | `/` is sealed on macOS; `~/.claude`, `~/.codex` follow the same convention. |
| 2 | "all of this in some test directory" + test toggle | The pill is fixed top-right on every screen. Test **on** → the app is rooted at `~/.engelbart/test/` (seeded library, settings gear with *Reset everything*). Test **off** → the same app rooted at `~/.engelbart/` with its own, separate library database and no seeds. Toggle state persists in `~/.engelbart/config.json`. *(Revised 2026-09-16 evening: the first version left test-off blank.)* | "create a new folder either in the engelbart root or in engelbart/test depending"; "the test sql should be different from normal one". |
| 3 | "use Supabase's local SDK" | **PGlite** (`@electric-sql/pglite`, Postgres in WASM, persisted to a directory) with plain SQL, migrations written as Postgres SQL. | There is no standalone "Supabase local SDK": local Supabase is a Docker stack, unusable inside an installable app. PGlite is what Supabase's own database.build uses; the schema ports to a Supabase project unchanged. Swap point is one module (`src/main/store/db.cjs`). |
| 4 | Library DB location | `~/.engelbart/test/library.pglite/` (root). Per-project notes DB at `<project>/notes.pglite/`. | As requested: library at the Engelbart root, notes table per project. |
| 5 | Library columns | `id, name, type (note|paper|git_repo|dataset|website, required), path?, url?, folder_path?, project_id?, created, last_edited`. | As requested. `project_id` is the join key to the project's notes table. |
| 6 | Notes table columns | `id, name, path, created, last_edited` **plus** nullable `goal_id`, `topic_id`. | The sidebar has to know which goal lists a note; frontmatter would put YAML into the md files. Flagged as an addition. |
| 7 | How library items get in | No import UI. Test mode seeds the library once (`fixtures/`): one paper (the HypoCompass PDF from the design), one website, one git repo, one dataset. Notes created in-app are inserted as `type=note`. | "I should not be able to import documents or anything" + "bare bones". |
| 8 | Goals / topics "same structure as projects" | Directories: `<project>/<goal>/<topic>/`. Each carries a small `meta.json` (id, created; goal: `box`; topic: `status`, `context`). No per-goal database. | Directory is the structure; the DB was specified for notes only. |
| 9 | "notes saved as individual files within the project, not in further subdirectories" | Every note is `<project>/<name>.md`, flat, plain markdown, regardless of the goal/topic it belongs to. The association lives in the notes table (§6). | Literal. |
| 10 | Topic "Workspace" document | `<project>/<goal>/<topic>/workspace.md`. It is the topic's own document, not a note, so it lives with the topic. | Keeps rule 9 for notes while giving each topic one document, as in the design. |
| 11 | "Future" ideas (sidebar) | `<project>/<goal>/future.md`, one `- idea` per line. | Per-goal in the design's state; markdown so it stays inspectable. |
| 12 | Terminal | The Experimental Terminal engine is embedded verbatim: its main-process session manager, launch/env sanitising, provider discovery, flow control, the `window.terminalAPI` bridge contract, and its xterm renderer logic. Sessions are real PTYs (shell / Claude Code / Codex). | "literally use the experimental terminal environment and just route everything through there". |
| 13 | Chat and todos | UI exactly as designed (`@chat ` line turns blue, Enter sends, reply comes back as `> quote` lines; `- todo` rows with Build / Build all and the queued→building→checking→done simulation). Replies are always a fixed placeholder. | As requested. |
| 14 | PDF viewer "ink" | pdf.js (rendering + text layer), rough.js (zigzag highlights, low-opacity arrows), Caveat (handwritten margin notes) — the three libraries the design loads. Bundled locally, no CDN. | "the js libraries that claude design uses to provide the ink". |
| 15 | PDF annotations storage | `~/.engelbart/test/annotations/<library_id>.json`. | Papers may live outside `.engelbart` (downloaded PDFs); the rule is that everything the app writes stays inside `.engelbart`. |
| 16 | Which library items open | Only papers with a local `path` (downloaded PDFs). Websites/repos open externally in the browser; datasets → placeholder pane. | As requested. |
| 17 | First run and multiple projects | With no project in the current root the app opens on the **Create a new project** screen (`design/goal-canvas` "Name Project.dc.html": name, `./slug` path, filled *Create project*). Creating makes the directory `<root>/<slug>`, a first goal **First steps** (Current), a first topic **Getting started**, and a **Welcome!** note attached to that topic, then lands in the workspace with the note open. With projects present, Home shows the cards and `+ Project` opens the same screen. Breadcrumb `Engelbart / project / box / goal`. | Request of 2026-09-16 evening. The workspace needs a goal and a topic to exist; naming them for what they are follows design message 26. |
| 18 | `@[chat]` inline chat *panels* (earlier iteration) | Dropped; only the final `@chat` line form is built. | The last two tweak messages define the line form. |
| 19 | Image paste into documents | Not built (it is an import). `![alt](http…)` lines still render. | Rule 7. |
| 20 | Deleting projects/goals/topics/notes | Not built. | Unrequested; destructive; a kink to decide on. |
| 21 | Sidebar (design update 2026-09-16 21:09, messages 26–27) | No "Topics / Notes / Ideas" labels. Header = the current topic: status mark, editable name, `n / m`; hovering it lists the sibling topics and `+ New`. Below: the topic's context **tree** (Workspace first; folders expand; double-click renames; notes and papers are children), then `+ Context` / `+ Folder`; the Later list pinned to the bottom. Items `@[mentioned]` in the topic's document appear as children too. | "call them what they actually are"; "allow me to create folders of the context". |
| 22 | Project directory name | `<root>/<slug>` where the slug is the path field of the create screen (default: slugified name); the display name lives in `project.json`. Renaming a project renames the directory only while it is still the name's own slug. | The create screen shows `./` + slug; the earlier rule "folder renamed with the project" is kept for the default case. |
| 23 | Context tree storage | `meta.context` is a tree: entries are library ids or `{ id, name, children }` folders, validated (depth ≤ 6, ≤ 500 entries, ids unique across the tree). | Folders are per topic, like the design's `res` folders. |

## 3. File-system layout (test mode)

```
~/.engelbart/
  config.json                    { "testMode": true }
  test/
    library.pglite/              root Postgres (PGlite) — table `library`
    annotations/<libraryId>.json PDF marks
    seed/                        copies of fixtures the seed rows point at
    <Project name>/
      project.json               { id, created }
      notes.pglite/              table `notes`
      <Note name>.md             flat, plain markdown (all notes of the project)
      <Goal name>/
        meta.json                { id, box: current|experimental|past, created }
        future.md                "- idea" per line
        <Topic name>/
          meta.json              { id, status: open|progress|done, context: [libraryId], created }
          workspace.md           the topic's document
```

Renaming a project/goal/topic renames its directory; ids are stable (in `*.json`); note paths in the library are rewritten on project rename. Names are sanitised for the filesystem (`/`, leading `.`, control chars stripped; collisions get ` 2`, ` 3`).

## 4. Architecture

Electron 44 (same as Experimental Terminal), Node 22, esbuild. Renderer: React 19, sandboxed + context-isolated, served from a privileged custom scheme `engelbart://app/` (so pdf.js's worker, fonts and fetch behave like a normal origin). CSP: `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self'`.

```
src/main/
  index.cjs            app lifecycle, window, menu, protocol, IPC registration (from ET)
  terminal/            session-manager, launch, provider-discovery, settings, window-lifecycle (from ET, unchanged)
  ipc-validation.cjs   trusted-renderer check (adapted to the engelbart:// origin)
  store/home.cjs       ~/.engelbart layout, config, test root, seeding
  store/db.cjs         PGlite open/migrate; library + notes SQL
  store/projects.cjs   projects/goals/topics/notes/docs on disk (+ DB index)
  store/library.cjs    library queries, file bytes, annotations
  ipc.cjs              validated `engelbart:*` handlers
src/preload.cjs        exposes window.terminalAPI (ET contract, unchanged) + window.engelbartAPI
src/renderer/
  index.html, index.jsx, styles.css (DS tokens copied from design/goal-canvas/_ds)
  api.js               thin wrappers over window.engelbartAPI
  model/               parseLine, todoLine, INLINE, mention helpers (pure, unit-tested)
  screens/Home.jsx, Canvas.jsx, Workspace.jsx
  workspace/Rail.jsx, DocTabs.jsx, DocEditor.jsx, MentionMenu.jsx, Popover.jsx, CtxModal.jsx, RightPane.jsx
  pdf/PaperView.jsx    pdf.js + rough.js + Caveat (port of the design's syncPdf/renderMarks/pdfMouseUp/freeWidth)
  terminal/TerminalPane.jsx, terminal-client.js (port of ET renderer: PendingEvents, flow control, key handling)
  ui/Button.jsx, TestToggle.jsx
```

Bridge (`window.engelbartAPI`, all async, validated in main):
`config()`, `setTestMode(bool)`, `listProjects()`, `createProject(name)`, `renameProject(id,name)`, `loadProject(id)` → full tree, `createGoal(pid,{name,box})`, `renameGoal`, `createTopic(gid,name)`, `renameTopic`, `setTopicStatus`, `setTopicContext(tid,[ids])`, `createNote(pid,{name,goalId?,topicId?})`, `renameNote`, `readDoc(ref)` / `writeDoc(ref,text)` where ref = `{kind:'note',id}` | `{kind:'workspace',topicId}` | `{kind:'future',goalId}`, `library()`, `readLibraryFile(id)` → bytes, `readAnnotations(id)` / `writeAnnotations(id,json)`, `openExternal(url)`.

## 5. Screens and behaviour (from the design; values are the design's)

**Test pill and gear** (all screens): fixed top-right, DS caps pill: `TEST · ON` (filled ink) / `TEST · OFF` (outline); in test mode a `⚙` sits left of it with *Reveal in Finder* and *Reset everything…* (native confirmation, then `~/.engelbart/test` is deleted and recreated).

**Create a new project** (first run, and `+ Project`): wordmark top-left; centred column ≤ 600 px; `Create a new project` 500 34px −0.4px; subtitle 17px `#4d4d4d`; card `#fafafa` 1px `#eaeaea` radius 12 with *Project name* (placeholder `e.g. Engelbart`) and *Project path* (`./` + mono slug, hint follows the name); filled *Create project* 440×48, disabled until a name exists.

**Home** (test on): wordmark `Engelbart` (500 17px, −0.2px) top-left, `+ Project` top-right beside the pill. Cards (1px `#eaeaea`, radius 8): name 14.5px/500, meta `n goals · edited …`. Creating: inline DS field, Enter creates and opens. Rename: click the name.

**Canvas**: grid `70fr 30fr` × `1fr 1fr`, gap 16, padding `64px 24px 24px`. Boxes: Current (rows 1–2, col 1), Experimental (row 1, col 2), Past (row 2, col 2); header micro-caps `LABEL` and `15% · n goals`; `+ Goal` micro-cap action at the right of each header. Goal cards: name + `n sources`; topic preview rows (✓ filled / dashed in-progress / grey open marks); past 1.15× zoom the source list with kind icons appears. ⌘/ctrl + wheel zooms (0.5–4) about the cursor, wheel pans, zoom past 2.6 on a hovered goal opens it; click opens with the zoom-and-fade transition (280 ms); Esc / crumbs zoom back out. Hint pill bottom-right.

**Workspace**: header crumbs `Engelbart / {project} / {box} / {goal}` (goal name editable on click), `esc zooms out` right. Three panes with two draggable 1px separators (rail 180–520 default 300, double-click resets; middle/right split default ½, clamped so neither pane is under ~300 px).

*Rail* (`#fafafa`): **Topics** (rows 14px; status mark button cycles open→progress→done; active row white with 1px ring; › / ⌃ pins the expansion, hover expands temporarily; expanded rows: Workspace, then each context item with its kind icon and micro-cap kind label, then `+ Context`), `+ Topic`; **Notes** (16px note icon, 14px name), `+ Note`; **Future** (`–` bullet, textarea, × only on hover, empty on blur removes), `+ Idea`. Context of a topic = `meta.context` ∪ library items `@[mentioned]` in its documents.

*Middle*: tabs (Workspace + opened notes, × on notes, ⌘1–9 switch); title input (500 22px, −0.3px; renames note/topic); one contentEditable surface, column 65ch centred, 17px/1.6. Obsidian-style: the caret's line shows its markdown source, every other line renders. Supported: `**bold**`, `*italic*`, `` `code` ``, `[text](url)`, `#`/`##`/`###`, `- [ ] todo` (2-space depth, Tab / Shift-Tab indent, ⌘⏎ builds, Build / × per row, `n todos · m done` + blue **Build all** after each group), `> quote`, `@[name]` mentions (blue, dotted underline; hover → popover kind/title/summary/facts; click opens), `@chat …` (blue `@chat`, ↑ send button, Enter sends, reply inserted as `> ` lines), ⌘B/⌘I/⌘K, ⌘Z/⇧⌘Z, `@` opens the mention menu (chat + library). Autosave 400 ms after the last change.

*Right*: tabs `Live preview | Paper | Dataset`. Live preview: placeholder card + the terminal below it (dark `#0a0a0a`, mono 12px, `claude | codex` launchers, sessions persist while hidden; default session is a shell in the project directory). Paper: title + pages as white sheets with gutters `clamp(20% of width, 64, 150)` on a `#f2f2f2` desk; text selectable; select + type → Caveat note in the nearer margin with a rough.js arrow; select + Enter → highlight only; click blank paper → free note whose width stops before printed text (no arrow); highlights `rgba(0,112,243,.14)` zigzag; annotations persist per library item. Dataset: placeholder.

*Add context modal*: `ADD CONTEXT TO {topic}`; options: New note (creates a flat note attached to the topic, opens in a tab) and Library (pick an existing library item). No import / link / GitHub / Drive.

## 6. Data model (SQL, Postgres dialect via PGlite)

```sql
-- root: library.pglite
create table if not exists library (
  id uuid primary key,
  name text not null,
  type text not null check (type in ('note','paper','git_repo','dataset','website')),
  path text, url text, folder_path text,
  project_id uuid,
  created timestamptz not null default now(),
  last_edited timestamptz not null default now()
);
-- per project: notes.pglite
create table if not exists notes (
  id uuid primary key,
  name text not null,
  path text not null,            -- relative to the project directory
  goal_id uuid, topic_id uuid,   -- addition, see §2 #6
  created timestamptz not null default now(),
  last_edited timestamptz not null default now()
);
```

A note is one row in both tables (same id); `library.path` is absolute, `notes.path` relative.

## 7. Testing

- `node --test test/*.test.cjs`: store (create/rename/notes/docs on a temp root), db (schema, note join, project rename rewrites paths), editor model (parseLine, todoLine, INLINE tokens, raw↔display offset mapping), ipc validation.
- `npm run test:pty`: the terminal integration test inherited from Experimental Terminal, run under Electron's ABI.
- Live check: `npm start`, walk the flow (create project → goal → topic → workspace todo → build → @chat → note → paper annotate → terminal), screenshots recorded in `docs/verification.md`.

## 8. Packaging

`npm run package` → `release/Engelbart-darwin-arm64/Engelbart.app` (electron-packager, `node-pty` and `@electric-sql/pglite` unpacked from asar). Unsigned, not notarised; first run of the packaged app creates `~/.engelbart/`.

## 9. Known kinks (left open on purpose)

1. The normal root (test off) has no seeds and no ingestion path yet, so its library only ever holds notes.
2. Library ingestion beyond seeds (register a downloaded PDF by path? watch a folder?).
3. Whether goals/topics also want SQL rows (they are directories + `meta.json` now).
4. Deleting anything; archiving Past goals; moving a goal between boxes.
5. Note↔goal association lives in the notes table, not in the file. Obsidian would use frontmatter properties.
6. Todo build statuses and chat replies are simulated; nothing records them.
7. Images in documents.
8. Multiple windows / one project open at a time.
