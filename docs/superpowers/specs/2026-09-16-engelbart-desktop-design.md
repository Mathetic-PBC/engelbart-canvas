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
| 24 | Design revision 2026-09-17 (messages 34–54): header | The workspace header is one row in three columns aligned with the panes: `Engelbart / {box} / {goal}` over the sidebar (goal name only while the sidebar is ≥ 260 px), the **document tabs** (tab-shaped, active tab white and merged with the page) over the document, and the pane switcher **Browser · Terminal · Paper · Dataset** over the right pane. No `esc zooms out`. | The design moved the tabs and the switcher into the header "as three columns". |
| 25 | Browser pane (replaces *Live preview*) | Tabs (◎ web / note icon file / ▲ sandbox, `+`), ← → ↻, an address that takes a URL, a file path, `sandbox:…` or `localhost:port`, a kind badge (`NEW / WEB / FILE / SANDBOX / LOCAL`), a ⋮ device-preset menu (Fit panel, iPhone SE/12 Pro/15 Pro Max, Pixel 8, iPad mini, custom width) and ⤢ (widens the right pane). Web and local addresses render in a sandboxed `<iframe>` (CSP `frame-src http: https:`); files are read through `engelbart:read-text-file` (project-relative, `~/` or absolute, inside the home directory, first 20 000 characters); sandboxes are a placeholder. | Messages 40–47: "a browser that can load any website, a file path, a cloud sandbox or a local server, edge to edge". |
| 26 | Terminal pane (its own pane, light) | Same tab strip as the browser (`›_ {cwd basename}`, `+` = ⌘T), the xterm body in light colours, and a bottom bar with `›_ {agent}` and `▭ {cwd}` chips and a **Terminal / Claude Code / Codex** switcher. Picking Claude Code or Codex starts (or focuses) that provider's PTY in the current tab's directory; ⌘1–9 switch terminal tabs while the terminal has focus. Sessions are still the Experimental Terminal engine's and survive pane switches. | Messages 34–39. |
| 27 | Todo block as a card | A run of todos is one `#fafafa` card (radius 10): rows with mark · text · status · ×, and a footer with **Copy all** (copies the block's markdown, shows *Copied* for 1.4 s) on the left and **Build all** on the right while anything is open; clicking the footer's whitespace inserts a line below the card. The per-row *Build* button is gone (⌘Enter still builds one row). | Messages 48–51, 54. |
| 28 | Chat replies | `@chat …` and its `> ` replies form one card: the question on top (send button hidden once answered), replies read-only (`contenteditable=false`, selectable) with one continuous 2px `#dcdcdc` rule down the left and a rounded bottom. A document never ends on a reply — an editable empty line always follows it (so ⌘A and the caret keep working). Backspace/Delete do not merge into a reply; an empty line right after one just goes away. | Messages 52–53. |
| 29 | Paper margin selection | The selected text is drawn as a pending highlight (`rgba(0,112,243,.22)`) and the native selection released, so clicking into the margin or the note keeps it; Escape or a click on the page clears it, Enter/typing turns it into a mark. | Message 44 (the margin glitch). |
| 30 | Editor rules (Hudson, 2026-09-17) | A heading's `#`/`##`/`###` never shows, not even with the caret inside it (Backspace at the start of the heading text drops the mark). Enter on an empty nested todo steps out one level; only an empty root todo leaves the list (so a child needs three Enters). A selection across lines (⌘A, shift-click) is left to the browser and the next input rebuilds the surviving lines — previously the editor collapsed such selections to the first line, which is why "delete everything, then `- `" misbehaved. | Hudson's bug list. |
| 31 | No kanban; where the app opens | The canvas screen is removed. The app opens straight into the topic you were last in (`<dataRoot>/state.json` = `{projectId, goalId, topicId}`; stale ids fall back to the first project/goal/topic; a project with no goal gets *First steps · Getting started*). `Engelbart` in the header or Escape shows **all projects**: the card grid plus a dashed **+ Project** card after the last card (the create screen is unchanged). The goal crumb in the header lists the project's goals by box, with `+ New goal` (creates *Goal n · Topic 1*); the goal name still renames on click. | Hudson: "Delete the kanban page entirely … take me to the Getting Started item … + Project as a dotted card". |

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

**All projects** (`Engelbart` in the header, or Escape): wordmark `Engelbart` (500 17px, −0.2px) top-left with `n projects`. Cards (1px `#eaeaea`, radius 8): name 14.5px/500, meta `n goals · edited …`, rename on click of the name; the grid ends with a dashed (`1px dashed #c9c9c9`) **+ Project** card that opens the create screen. Opening a card lands in the project's last topic. The app itself starts in the last topic you were in (decision 31).

**Workspace**: header (`#fafafa`, min-height 46, three columns): `Engelbart / {box} / {goal}` over the sidebar — hovering the crumb lists the goals by box with `+ New goal`, clicking the goal name renames it; the document tabs (12.5px, active `#fff` with `#eaeaea` sides, closable ×) over the document; `Browser · Terminal · Paper · Dataset` (13px, 2px underline) over the right pane. Three panes with two draggable 1px separators (rail 180–520 default 300, double-click resets; middle/right split default ½, clamped so neither pane is under ~300 px; ⤢ in the browser toolbar toggles a wide right pane).

*Rail* (`#fafafa`): **Topics** (rows 14px; status mark button cycles open→progress→done; active row white with 1px ring; › / ⌃ pins the expansion, hover expands temporarily; expanded rows: Workspace, then each context item with its kind icon and micro-cap kind label, then `+ Context`), `+ Topic`; **Notes** (16px note icon, 14px name), `+ Note`; **Future** (`–` bullet, textarea, × only on hover, empty on blur removes), `+ Idea`. Context of a topic = `meta.context` ∪ library items `@[mentioned]` in its documents.

*Middle*: tabs (Workspace + opened notes, × on notes, ⌘1–9 switch); title input (500 22px, −0.3px; renames note/topic); one contentEditable surface, column 65ch centred, 17px/1.6. Obsidian-style: the caret's line shows its markdown source, every other line renders. Supported: `**bold**`, `*italic*`, `` `code` ``, `[text](url)`, `#`/`##`/`###`, `- [ ] todo` (2-space depth, Tab / Shift-Tab indent, ⌘⏎ builds, Build / × per row, `n todos · m done` + blue **Build all** after each group), `> quote`, `@[name]` mentions (blue, dotted underline; hover → popover kind/title/summary/facts; click opens), `@chat …` (blue `@chat`, ↑ send button, Enter sends, reply inserted as `> ` lines), ⌘B/⌘I/⌘K, ⌘Z/⇧⌘Z, `@` opens the mention menu (chat + library). Autosave 400 ms after the last change.

*Right* (edge to edge, no padding): **Browser** — tab strip (`#fafafa`, tabs 12px, `+`), toolbar ← → ↻ · address (30px, radius 8, `#fafafa`, kind badge + centred mono input, placeholder `url · file path · sandbox · localhost:port`) · ⋮ device presets · ⤢; blank state `Enter a URL, a file path, a sandbox, or a local port.` on a radial `#f2f2f2→#fafafa` wash; web/local in an iframe (device width centred on `#f2f2f2`); file as mono 12.5px/1.7 text. **Terminal** — the same tab strip, light xterm body (12.5px mono, cursor `#0070f3`), bottom bar with the agent and cwd chips and the `Terminal · Claude Code · Codex` switcher. **Paper** — title block padded `14px 20px 0`, pages edge to edge under a 1px rule, with gutters `clamp(20% of width, 64, 150)` on a white sheet; selection → pending highlight → type a note (Caveat) in the margin, Enter for a bare highlight, click the page for a free note; rough.js zigzag highlights and arrows; annotations saved per paper. **Dataset** — placeholder (`14px 20px 20px`).

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
9. Without the canvas, a goal's box (Current / Experimental / Past) is only a label in the goal menu: new goals land in Current and nothing moves them.
10. The browser pane is an `<iframe>`: sites that refuse framing (`X-Frame-Options`, frame-ancestors) stay blank, and there is no navigation history inside the frame (← → walk the address history only). Sandboxes are not connected.
11. Selecting across a rendered line and deleting keeps that line's type (todo, heading) but loses inline markup the rendered view did not show (bold, links).
